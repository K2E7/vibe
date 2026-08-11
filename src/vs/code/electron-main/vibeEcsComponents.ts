/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../base/common/async.js';
import type { ILogService } from '../../platform/log/common/log.js';

const WIDEVINE_STARTUP_TIMEOUT = 15_000;

interface EcsComponentResult {
	readonly id: string;
	readonly status: string;
	readonly version: string | null;
}

interface EcsComponents {
	readonly WIDEVINE_CDM_ID: string;
	whenReady(required?: string[]): Promise<EcsComponentResult[]>;
}

export interface VibeEcsComponentsEnvironment {
	readonly platform: string;
	readonly architecture: string;
	readonly loadElectron: () => Promise<object>;
	readonly timeout: number;
}

const defaultEnvironment: VibeEcsComponentsEnvironment = {
	platform: process.platform,
	architecture: process.arch,
	loadElectron: () => import('electron'),
	timeout: WIDEVINE_STARTUP_TIMEOUT
};

function getEcsComponents(electronModule: object): EcsComponents | undefined {
	const components = (electronModule as { readonly components?: Partial<EcsComponents> }).components;
	if (typeof components?.WIDEVINE_CDM_ID !== 'string' || typeof components.whenReady !== 'function') {
		return undefined;
	}

	return components as EcsComponents;
}

export async function initializeVibeEcsComponents(logService: ILogService, environment: VibeEcsComponentsEnvironment = defaultEnvironment): Promise<void> {
	if (environment.platform !== 'win32' || environment.architecture !== 'arm64') {
		return;
	}

	try {
		const components = getEcsComponents(await environment.loadElectron());
		if (!components) {
			return;
		}

		const componentId = components.WIDEVINE_CDM_ID;
		const results = await raceTimeout(
			components.whenReady([componentId]),
			environment.timeout,
			() => logService.warn(`[Vibe ECS] Timed out after ${environment.timeout}ms waiting for component '${componentId}'; Code startup will continue.`)
		);
		if (!results) {
			return;
		}

		const component = results.find(result => result.id === componentId);
		const details = [`id=${componentId}`];
		if (component?.status) {
			details.push(`status=${component.status}`);
		}
		if (component?.version) {
			details.push(`version=${component.version}`);
		}

		logService.info(`[Vibe ECS] Component initialized: ${details.join(', ')}`);
	} catch (error) {
		logService.error('[Vibe ECS] Widevine component initialization failed; Code startup will continue.', error);
	}
}
