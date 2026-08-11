/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewBounds, IBrowserViewKeyDownEvent, IBrowserViewLoadingEvent, IBrowserViewNavigationEvent, IBrowserViewVisibilityEvent } from '../../../../../platform/browserView/common/browserView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import { IBrowserOverlayInfo, IBrowserOverlayManager } from '../../electron-browser/overlayManager.js';
import { IWebContentsViewPresenterHost, WebContentsViewPresenter } from '../../electron-browser/webContentsViewPresenter.js';

suite('WebContentsViewPresenter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createPresenter(overlayManager: TestBrowserOverlayManager): WebContentsViewPresenter {
		const host: IWebContentsViewPresenterHost = {
			window: mainWindow,
			hasPage: () => true,
			ensureBrowserFocus: () => { },
		};
		const keybindingService = {
			dispatchEvent: () => false,
		} as Partial<IKeybindingService> as IKeybindingService;
		return new WebContentsViewPresenter(host, overlayManager, new NullLogService(), keybindingService);
	}

	test('attaches and replaces models without retaining old listeners', () => {
		const overlayManager = disposables.add(new TestBrowserOverlayManager());
		const presenter = disposables.add(createPresenter(overlayManager));
		const first = disposables.add(new TestBrowserViewModel('https://example.com/first'));
		const second = disposables.add(new TestBrowserViewModel('https://example.com/second'));

		presenter.attachModel(first.model);
		const afterFirstAttach = {
			firstHasListeners: first.hasPresenterListeners,
			placeholderDisplay: presenter.placeholderScreenshot.style.display,
		};

		presenter.attachModel(second.model);

		assert.deepStrictEqual({
			afterFirstAttach,
			firstHasListeners: first.hasPresenterListeners,
			secondHasListeners: second.hasPresenterListeners,
			placeholderDisplay: presenter.placeholderScreenshot.style.display,
		}, {
			afterFirstAttach: {
				firstHasListeners: true,
				placeholderDisplay: '',
			},
			firstHasListeners: false,
			secondHasListeners: true,
			placeholderDisplay: '',
		});
	});

	test('detach hides the native view and clears presentation state', () => {
		const overlayManager = disposables.add(new TestBrowserOverlayManager());
		const presenter = disposables.add(createPresenter(overlayManager));
		const model = disposables.add(new TestBrowserViewModel('https://example.com', true));

		presenter.attachModel(model.model);
		presenter.detachModel();

		assert.deepStrictEqual({
			visibilityCalls: model.visibilityCalls,
			hasListeners: model.hasPresenterListeners,
			placeholderDisplay: presenter.placeholderScreenshot.style.display,
			placeholderImage: presenter.placeholderScreenshot.style.backgroundImage,
		}, {
			visibilityCalls: [false],
			hasListeners: false,
			placeholderDisplay: 'none',
			placeholderImage: '',
		});
	});

	test('show is immediate and supersedes a pending delayed hide', async () => {
		const overlayManager = disposables.add(new TestBrowserOverlayManager());
		const presenter = disposables.add(createPresenter(overlayManager));
		const model = disposables.add(new TestBrowserViewModel('https://example.com'));

		presenter.attachModel(model.model);
		presenter.setVisible(true);
		presenter.setVisible(false);
		presenter.setVisible(true);
		await nextAnimationFrame();
		const afterCancelledHide = [...model.visibilityCalls];

		presenter.setVisible(false);
		await nextAnimationFrame();

		assert.deepStrictEqual({
			afterCancelledHide,
			finalVisibilityCalls: model.visibilityCalls,
		}, {
			afterCancelledHide: [true],
			finalVisibilityCalls: [true, false],
		});
	});

	test('forwards final bounds to the attached model', () => {
		const overlayManager = disposables.add(new TestBrowserOverlayManager());
		const presenter = disposables.add(createPresenter(overlayManager));
		const model = disposables.add(new TestBrowserViewModel('https://example.com'));
		const bounds: IBrowserViewBounds = {
			windowId: 7,
			x: 11,
			y: 13,
			width: 617,
			height: 431,
			zoomFactor: 1.25,
			cornerRadius: 4,
			emulation: { scale: 0.75 },
		};

		presenter.attachModel(model.model);
		presenter.layout(bounds);

		assert.deepStrictEqual(model.layoutCalls, [bounds]);
	});

	test('disposal releases model and overlay listeners', () => {
		const overlayManager = disposables.add(new TestBrowserOverlayManager());
		const presenter = createPresenter(overlayManager);
		const model = disposables.add(new TestBrowserViewModel('https://example.com'));
		presenter.attachModel(model.model);

		const beforeDispose = {
			modelHasListeners: model.hasPresenterListeners,
			overlayHasListeners: overlayManager.hasListeners,
		};
		presenter.dispose();

		assert.deepStrictEqual({
			beforeDispose,
			modelHasListeners: model.hasPresenterListeners,
			overlayHasListeners: overlayManager.hasListeners,
		}, {
			beforeDispose: {
				modelHasListeners: true,
				overlayHasListeners: true,
			},
			modelHasListeners: false,
			overlayHasListeners: false,
		});
	});

	function nextAnimationFrame(): Promise<void> {
		return new Promise(resolve => mainWindow.requestAnimationFrame(() => resolve()));
	}
});

class TestBrowserOverlayManager extends Disposable implements IBrowserOverlayManager {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeOverlayState = this._register(new Emitter<void>());
	readonly onDidChangeOverlayState = this._onDidChangeOverlayState.event;

	get hasListeners(): boolean {
		return this._onDidChangeOverlayState.hasListeners();
	}

	getOverlappingOverlays(_element: HTMLElement): IBrowserOverlayInfo[] {
		return [];
	}
}

class TestBrowserViewModel extends Disposable {
	private readonly _onDidNavigate = this._register(new Emitter<IBrowserViewNavigationEvent>());
	private readonly _onDidChangeLoadingState = this._register(new Emitter<IBrowserViewLoadingEvent>());
	private readonly _onDidKeyCommand = this._register(new Emitter<IBrowserViewKeyDownEvent>());
	private readonly _onDidChangeVisibility = this._register(new Emitter<IBrowserViewVisibilityEvent>());
	private _visible: boolean;

	readonly visibilityCalls: boolean[] = [];
	readonly layoutCalls: IBrowserViewBounds[] = [];
	readonly model: IBrowserViewModel;

	constructor(url: string, visible = false) {
		super();
		this._visible = visible;
		const testModel = this;
		this.model = {
			id: 'test-browser',
			url,
			screenshot: undefined,
			error: undefined,
			focused: false,
			get visible() { return testModel._visible; },
			onDidNavigate: this._onDidNavigate.event,
			onDidChangeLoadingState: this._onDidChangeLoadingState.event,
			onDidKeyCommand: this._onDidKeyCommand.event,
			onDidChangeVisibility: this._onDidChangeVisibility.event,
			setVisible: async visible => {
				this.visibilityCalls.push(visible);
				this._visible = visible;
			},
			layout: async bounds => {
				this.layoutCalls.push(bounds);
			},
			captureScreenshot: async () => VSBuffer.fromString('screenshot'),
			dispose: () => this.dispose(),
		} as Partial<IBrowserViewModel> as IBrowserViewModel;
	}

	get hasPresenterListeners(): boolean {
		return this._onDidNavigate.hasListeners()
			&& this._onDidChangeLoadingState.hasListeners()
			&& this._onDidKeyCommand.hasListeners()
			&& this._onDidChangeVisibility.hasListeners();
	}
}
