/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { initializeVibeEcsComponents, type VibeEcsComponentsEnvironment } from '../../electron-main/vibeEcsComponents.js';

const widevineComponentId = 'oimompecagnajdejgnnjijobebaeigek';

class RecordingLogService extends NullLogService {
	readonly infos: string[] = [];
	readonly warnings: string[] = [];
	readonly errors: string[] = [];

	override info(message: string): void {
		this.infos.push(message);
	}

	override warn(message: string): void {
		this.warnings.push(message);
	}

	override error(message: string | Error): void {
		this.errors.push(message instanceof Error ? message.message : message);
	}
}

function environment(platform: string, architecture: string, electronModule: object, timeout = 15_000): VibeEcsComponentsEnvironment {
	return {
		platform,
		architecture,
		loadElectron: async () => electronModule,
		timeout
	};
}

suite('Vibe ECS components', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('initializes Widevine exactly once with an explicit component ID and logs success', async () => {
		let callCount = 0;
		let argumentCount = 0;
		let requiredComponents: string[] | undefined;
		async function whenReady(required?: string[]) {
			callCount++;
			argumentCount = arguments.length;
			requiredComponents = required;
			return [{ id: widevineComponentId, status: 'ready', version: '4.10.2891.0' }];
		}

		const logService = new RecordingLogService();
		await initializeVibeEcsComponents(logService, environment('win32', 'arm64', {
			components: {
				WIDEVINE_CDM_ID: widevineComponentId,
				whenReady
			}
		}));

		assert.deepStrictEqual({
			callCount,
			argumentCount,
			requiredComponents,
			infos: logService.infos
		}, {
			callCount: 1,
			argumentCount: 1,
			requiredComponents: [widevineComponentId],
			infos: [`[Vibe ECS] Component initialized: id=${widevineComponentId}, status=ready, version=4.10.2891.0`]
		});
	});

	test('does not initialize on Windows x64', async () => {
		let loadCount = 0;
		const logService = new RecordingLogService();
		await initializeVibeEcsComponents(logService, {
			platform: 'win32',
			architecture: 'x64',
			loadElectron: async () => {
				loadCount++;
				return {};
			},
			timeout: 15_000
		});

		assert.deepStrictEqual({ loadCount, infos: logService.infos, warnings: logService.warnings, errors: logService.errors }, { loadCount: 0, infos: [], warnings: [], errors: [] });
	});

	test('does not initialize on non-Windows platforms', async () => {
		let loadCount = 0;
		const logService = new RecordingLogService();
		await initializeVibeEcsComponents(logService, {
			platform: 'linux',
			architecture: 'arm64',
			loadElectron: async () => {
				loadCount++;
				return {};
			},
			timeout: 15_000
		});

		assert.deepStrictEqual({ loadCount, infos: logService.infos, warnings: logService.warnings, errors: logService.errors }, { loadCount: 0, infos: [], warnings: [], errors: [] });
	});

	test('silently ignores stock Electron on Windows ARM64', async () => {
		const logService = new RecordingLogService();
		await initializeVibeEcsComponents(logService, environment('win32', 'arm64', {}));

		assert.deepStrictEqual({ infos: logService.infos, warnings: logService.warnings, errors: logService.errors }, { infos: [], warnings: [], errors: [] });
	});

	test('logs component rejection and resolves', async () => {
		const logService = new RecordingLogService();
		await initializeVibeEcsComponents(logService, environment('win32', 'arm64', {
			components: {
				WIDEVINE_CDM_ID: widevineComponentId,
				whenReady: async () => { throw new Error('component download failed'); }
			}
		}));

		assert.deepStrictEqual(logService.errors, ['[Vibe ECS] Widevine component initialization failed; Code startup will continue.']);
	});

	test('logs timeout and resolves', async () => {
		const logService = new RecordingLogService();
		await initializeVibeEcsComponents(logService, environment('win32', 'arm64', {
			components: {
				WIDEVINE_CDM_ID: widevineComponentId,
				whenReady: async () => new Promise(() => { })
			}
		}, 1));

		assert.deepStrictEqual(logService.warnings, [`[Vibe ECS] Timed out after 1ms waiting for component '${widevineComponentId}'; Code startup will continue.`]);
	});
});
