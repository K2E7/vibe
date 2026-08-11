/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor } from '../../../../base/browser/browser.js';
import { $, addDisposableListener, EventType, registerExternalFocusChecker } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IBrowserViewBounds, IBrowserViewKeyDownEvent } from '../../../../platform/browserView/common/browserView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../common/browserView.js';
import type { IContainerLayout, IContainerLayoutOverride } from './browserEditor.js';
import { BrowserOverlayType, IBrowserOverlayManager } from './overlayManager.js';

/** Host callbacks needed to present a native browser view. */
export interface IWebContentsViewPresenterHost {
	readonly window: CodeWindow;
	hasPage(): boolean;
	ensureBrowserFocus(): void;
}

/**
 * Presents a browser view model through its native Electron WebContentsView.
 *
 * The presenter owns behavior specific to native browser surfaces, while its
 * host owns surrounding chrome and decides when a model or container is
 * attached.
 */
export class WebContentsViewPresenter extends Disposable {

	private _container: HTMLElement | undefined;
	private _model: IBrowserViewModel | undefined;
	private _hostVisible = false;
	private _overlayObscured = false;

	readonly placeholderScreenshot = $('.browser-placeholder-screenshot');
	readonly overlayPauseElement = $('.browser-overlay-paused');

	private readonly _modelStore = this._register(new DisposableStore());
	private readonly _screenshotHandle = this._register(new MutableDisposable());
	private _focusTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly host: IWebContentsViewPresenterHost,
		private readonly overlayManager: IBrowserOverlayManager,
		private readonly logService: ILogService,
		private readonly keybindingService: IKeybindingService,
	) {
		super();

		const message = $('.browser-overlay-paused-message');
		const heading = $('.browser-overlay-paused-heading');
		const detail = $('.browser-overlay-paused-detail');
		heading.textContent = localize('browser.overlayPauseHeading.notification', "Paused due to Notification");
		detail.textContent = localize('browser.overlayPauseDetail.notification', "Dismiss the notification to continue using the browser.");
		message.appendChild(heading);
		message.appendChild(detail);
		this.overlayPauseElement.appendChild(message);

		this._register(this.overlayManager.onDidChangeOverlayState(() => this._refreshOverlayObscured()));
		this._refresh();
	}

	/** Attach the DOM element whose bounds and focus represent the native view. */
	setContainer(container: HTMLElement): void {
		this._container = container;

		this._register(addDisposableListener(container, EventType.FOCUS, () => this.focus()));
		this._register(addDisposableListener(container, EventType.BLUR, () => this._cancelFocusTimeout()));

		// Cross-window focus logic uses this checker because the WCV lives
		// outside the DOM tree and can't be detected with activeElement.
		this._register(registerExternalFocusChecker(() => ({
			hasFocus: this._model?.focused ?? false,
			window: this._model?.focused ? this.host.window : undefined,
		})));

		this._refreshOverlayObscured();
	}

	/** Attach a browser model without taking ownership of it. */
	attachModel(model: IBrowserViewModel): void {
		this._modelStore.clear();
		this._model = model;
		this._setBackgroundImage(model.screenshot);

		this._modelStore.add(model.onDidChangeVisibility(() => void this._doScreenshot()));
		this._modelStore.add(model.onDidKeyCommand(keyEvent => void this._handleKeyEvent(keyEvent)));
		this._modelStore.add(model.onDidNavigate(() => this._refresh()));
		this._modelStore.add(model.onDidChangeLoadingState(() => this._refresh()));

		this._refresh();
		void this._doScreenshot();
	}

	/** Detach the current model, hiding its native view without disposing it. */
	detachModel(): void {
		this._modelStore.clear();
		if (this._model) {
			void this._model.setVisible(false);
		}
		this._model = undefined;
		this._screenshotHandle.clear();
		this._cancelFocusTimeout();
		this._setBackgroundImage(undefined);
		this._refresh();
	}

	/** Set whether the host surface is currently visible. */
	setVisible(visible: boolean): void {
		if (this._hostVisible === visible) {
			return;
		}
		this._hostVisible = visible;
		this._refresh();
	}

	/** Forward the final native-view bounds to the attached model. */
	layout(bounds: IBrowserViewBounds): void {
		if (this._model) {
			void this._model.layout(bounds);
		}
	}

	/**
	 * Return the baseline padding and pixel-snap transform required by the
	 * native WebContentsView.
	 */
	getLayoutOverride(): IContainerLayoutOverride {
		return {
			padding: { top: 3, right: 3, bottom: 3, left: 3 },

			// Snap CSS-pixel values down so `v × hostZoom` is an exact integer:
			// main places the WCV at `round(v × hostZoom) × systemDPR` physical
			// pixels while CSS renders it at `v × hostZoom × systemDPR`, so this
			// collapses main's rounding to a no-op and keeps the WebContentsView
			// aligned with the placeholder screenshot. We snap the absolute
			// origin (pane origin + local offset) then derive the corresponding
			// local position so the DOM element and the WCV land on the same
			// physical pixel. Runs late so it refines whatever sizing upstream
			// contributions (e.g. device emulation) produced.
			compute: (current, pane): IContainerLayout => {
				const zoomFactor = getZoomFactor(this.host.window);
				const snap = (value: number) => Math.floor(value * zoomFactor) / zoomFactor;
				const absoluteLeft = pane.originX + (current.left ?? 0);
				const absoluteTop = pane.originY + (current.top ?? 0);
				return {
					...current,
					width: snap(current.width),
					height: snap(current.height),
					left: snap(absoluteLeft) - pane.originX,
					top: snap(absoluteTop) - pane.originY,
				};
			},
			priority: 1000,
		};
	}

	/** Recompute overlay visibility after the native container moves or resizes. */
	afterLayout(): void {
		this._refreshOverlayObscured();
	}

	/** Focus the native browser view when this presenter can handle focus. */
	focus(): boolean {
		if (!this.host.hasPage()) {
			return false;
		}
		this._container?.focus();
		if (this._focusTimeout || !this._model) {
			return true;
		}
		this._focusTimeout = setTimeout(() => {
			this._focusTimeout = undefined;
			const ownerDocument = this._container?.ownerDocument;
			if (!ownerDocument?.hasFocus() || ownerDocument.activeElement !== this._container) {
				return;
			}
			if (this._model?.visible) {
				void this._model.focus();
			} else {
				this.host.ensureBrowserFocus();
			}
		}, 10);
		return true;
	}

	private _shouldShowPage(): boolean {
		return this._hostVisible
			&& !this._overlayObscured
			&& !!this._model?.url
			&& !this._model?.error;
	}

	/**
	 * Recompute visibility of the content layers and underlying native page
	 * based on the latest host, overlay, and model state.
	 */
	private _refresh(): void {
		// Placeholder screenshot: shown whenever there's a page to render
		// (covered by the WCV when it's up, visible during hide/show swaps).
		const placeholderActive = !!this._model?.url && !this._model?.error;
		this.placeholderScreenshot.style.display = placeholderActive ? '' : 'none';

		// Overlay-pause overlay: fades in when an overlay obscures the page.
		const pauseActive = !!this._model?.url && this._hostVisible && this._overlayObscured;
		this.overlayPauseElement.classList.toggle('visible', pauseActive);

		if (!this._model) {
			return;
		}
		const show = this._shouldShowPage();
		if (show === this._model.visible) {
			return;
		}
		if (show) {
			void this._model.setVisible(true);
			// If the presenter container is focused, ensure the WCV gets focus too.
			const ownerDocument = this._container?.ownerDocument;
			if (ownerDocument?.hasFocus() && ownerDocument.activeElement === this._container) {
				this.focus();
			}
		} else {
			void this._doScreenshot();
			// Defer the hide one frame so the latest screenshot has a chance to paint first.
			this.host.window.requestAnimationFrame(() => {
				// Double check that we should still hide the page.
				if (this._model && !this._shouldShowPage()) {
					void this._model.setVisible(false);
				}
			});
		}
	}

	private _refreshOverlayObscured(): void {
		if (!this._container) {
			return;
		}
		const overlays = this.overlayManager.getOverlappingOverlays(this._container);
		const obscured = overlays.length > 0;
		const hasNotification = overlays.some(overlay => overlay.type === BrowserOverlayType.Notification);
		this.overlayPauseElement.classList.toggle('show-message', hasNotification);
		if (obscured !== this._overlayObscured) {
			this._overlayObscured = obscured;
			this._refresh();
		}
	}

	private async _doScreenshot(): Promise<void> {
		if (!this._model) {
			return;
		}
		this._screenshotHandle.clear();
		if (!this._model.visible) {
			return;
		}
		try {
			const screenshot = await this._model.captureScreenshot({ quality: 80 });
			this._setBackgroundImage(screenshot);
		} catch (error) {
			this.logService.error('Failed to capture browser view screenshot', error);
		}
		const handle = setTimeout(() => void this._doScreenshot(), 1000);
		this._screenshotHandle.value = toDisposable(() => clearTimeout(handle));
	}

	private _setBackgroundImage(buffer: VSBuffer | undefined): void {
		if (buffer) {
			const dataUrl = `data:image/jpeg;base64,${encodeBase64(buffer)}`;
			this.placeholderScreenshot.style.backgroundImage = `url('${dataUrl}')`;
		} else {
			this.placeholderScreenshot.style.backgroundImage = '';
		}
	}

	private async _handleKeyEvent(keyEvent: IBrowserViewKeyDownEvent): Promise<void> {
		if (!this._container) {
			return;
		}
		try {
			const syntheticEvent = new KeyboardEvent('keydown', keyEvent);
			const standardEvent = new StandardKeyboardEvent(syntheticEvent);
			this.keybindingService.dispatchEvent(standardEvent, this._container);
		} catch (error) {
			this.logService.error('WebContentsViewRendererFeature: Error dispatching key event', error);
		}
	}

	private _cancelFocusTimeout(): void {
		if (this._focusTimeout) {
			clearTimeout(this._focusTimeout);
			this._focusTimeout = undefined;
		}
	}

	override dispose(): void {
		this._cancelFocusTimeout();
		super.dispose();
	}
}
