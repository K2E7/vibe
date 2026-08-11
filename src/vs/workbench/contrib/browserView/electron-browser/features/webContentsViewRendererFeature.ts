/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IBrowserViewBounds } from '../../../../../platform/browserView/common/browserView.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import {
	BrowserEditor,
	BrowserEditorContribution,
	BrowserWidgetLocation,
	IBrowserEditorWidget,
	IContainerLayoutOverride,
} from '../browserEditor.js';
import { BrowserOverlayManager } from '../overlayManager.js';
import { WebContentsViewPresenter } from '../webContentsViewPresenter.js';

/** Adapts the native WebContentsView presenter to the browser editor contribution API. */
class WebContentsViewRendererFeature extends BrowserEditorContribution {
	private readonly _presenter: WebContentsViewPresenter;
	private readonly _placeholderContent: IBrowserEditorWidget;
	private readonly _overlayPauseContent: IBrowserEditorWidget;

	constructor(
		editor: BrowserEditor,
		@ILogService logService: ILogService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super(editor);

		const overlayManager = this._register(new BrowserOverlayManager(editor.window));
		this._presenter = this._register(new WebContentsViewPresenter({
			window: editor.window,
			hasPage: () => !!editor.input?.url,
			ensureBrowserFocus: () => editor.ensureBrowserFocus(),
		}, overlayManager, logService, keybindingService));

		this._placeholderContent = { location: BrowserWidgetLocation.ContentArea, element: this._presenter.placeholderScreenshot, order: 100 };
		this._overlayPauseContent = { location: BrowserWidgetLocation.ContentArea, element: this._presenter.overlayPauseElement, order: 200 };
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [this._placeholderContent, this._overlayPauseContent];
	}

	override beforeContainerLayout(): IContainerLayoutOverride {
		return this._presenter.getLayoutOverride();
	}

	override onContainerCreated(container: HTMLElement): void {
		this._presenter.setContainer(container);
	}

	// -- Base contribution hooks --------------------------------------------

	override onPaneVisibilityChanged(visible: boolean): void {
		this._presenter.setVisible(visible);
	}

	override afterContainerLayout(): void {
		// Container moved or resized — overlays that overlap us might have
		// shifted relative to the container even though their own DOM didn't
		// change. Recompute obscured state so the page can hide accordingly.
		this._presenter.afterLayout();
	}

	override tryFocus(): boolean {
		return this._presenter.focus();
	}

	// -- Model lifecycle ----------------------------------------------------

	protected override onModelAttached(model: IBrowserViewModel): void {
		this._presenter.attachModel(model);
	}

	override onModelDetached(): void {
		this._presenter.detachModel();
	}

	override layoutBrowserView(bounds: IBrowserViewBounds): boolean {
		this._presenter.layout(bounds);
		return true;
	}
}

BrowserEditor.registerContribution(WebContentsViewRendererFeature);
