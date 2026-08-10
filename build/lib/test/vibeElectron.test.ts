/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { getVibeElectronVersion, supportedEcsElectronVersion, supportedElectronBaseVersion } from '../vibeElectron.ts';

suite('vibeElectron', () => {
	test('selects ECS only for Windows ARM64', () => {
		assert.deepStrictEqual({
			win32Arm64: getVibeElectronVersion(supportedElectronBaseVersion, 'win32', 'arm64'),
			win32X64: getVibeElectronVersion(supportedElectronBaseVersion, 'win32', 'x64'),
			darwinArm64: getVibeElectronVersion(supportedElectronBaseVersion, 'darwin', 'arm64'),
			linuxArm64: getVibeElectronVersion(supportedElectronBaseVersion, 'linux', 'arm64'),
		}, {
			win32Arm64: supportedEcsElectronVersion,
			win32X64: supportedElectronBaseVersion,
			darwinArm64: supportedElectronBaseVersion,
			linuxArm64: supportedElectronBaseVersion,
		});
	});

	test('rejects an unexpected upstream Electron version for Windows ARM64', () => {
		assert.throws(
			() => getVibeElectronVersion('43.0.0', 'win32', 'arm64'),
			/Unsupported upstream Electron version '43\.0\.0'.*Update the Castlabs ECS mapping and checksum before continuing\./
		);
	});
});
