/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { suite, test } from 'node:test';
import {
	createAuthenticodeSignCommand,
	createAuthenticodeVerifyCommand,
	createEvsCommands,
	createGulpCommand,
	createPackagingEnvironment,
	derivePackageInfo,
	enumeratePeFiles,
	readSigningConfiguration,
	runCheckedCommand,
} from '../../vibe/package-win32-arm64.ts';

suite('Vibe Windows ARM64 package wrapper', () => {
	test('constructs gulp and Authenticode commands', () => {
		const repositoryRoot = path.resolve('workspace', 'vibe');
		const signToolPath = path.resolve('sdk', 'signtool.exe');
		const filePath = path.resolve('package', 'Code - OSS.exe');
		const nodeExecutable = path.resolve('node', 'node.exe');
		const npmExecPath = path.resolve('npm', 'npm-cli.js');
		const packagingEnvironment = { npm_execpath: npmExecPath };
		const configuration = {
			certificateSha1: 'A'.repeat(40),
			timestampUrl: 'https://timestamp.example.test',
		};

		assert.deepStrictEqual({
			packageTask: createGulpCommand(repositoryRoot, 'vscode-win32-arm64-min', packagingEnvironment, nodeExecutable),
			updaterTask: createGulpCommand(repositoryRoot, 'vscode-win32-arm64-inno-updater', packagingEnvironment, nodeExecutable),
			sign: createAuthenticodeSignCommand(signToolPath, configuration, filePath),
			verify: createAuthenticodeVerifyCommand(signToolPath, filePath),
		}, {
			packageTask: {
				executable: nodeExecutable,
				args: [npmExecPath, 'run', 'gulp', '--', 'vscode-win32-arm64-min'],
				description: 'Build task vscode-win32-arm64-min',
				cwd: repositoryRoot,
				environment: packagingEnvironment,
			},
			updaterTask: {
				executable: nodeExecutable,
				args: [npmExecPath, 'run', 'gulp', '--', 'vscode-win32-arm64-inno-updater'],
				description: 'Build task vscode-win32-arm64-inno-updater',
				cwd: repositoryRoot,
				environment: packagingEnvironment,
			},
			sign: {
				executable: signToolPath,
				args: ['sign', '/sha1', 'A'.repeat(40), '/s', 'My', '/fd', 'SHA256', '/as', '/tr', 'https://timestamp.example.test', '/td', 'SHA256', filePath],
				description: 'Authenticode sign Code - OSS.exe',
			},
			verify: {
				executable: signToolPath,
				args: ['verify', '/pa', '/all', filePath],
				description: 'Authenticode verify Code - OSS.exe',
			},
		});
	});

	test('prepends the discovered SignTool directory to the gulp child PATH', () => {
		const signToolPath = path.resolve('Windows Kits', '10', 'bin', 'arm64', 'signtool.exe');
		const environment = createPackagingEnvironment(signToolPath, {
			npm_execpath: 'npm-cli.js',
			Path: ['existing', 'tools'].join(path.delimiter),
			VIBE_PYTHON_PATH: 'python.exe',
		});
		const command = createGulpCommand('repository', 'task', environment, 'node.exe');

		assert.deepStrictEqual(command.environment, {
			npm_execpath: 'npm-cli.js',
			Path: [path.dirname(signToolPath), 'existing', 'tools'].join(path.delimiter),
			VIBE_PYTHON_PATH: 'python.exe',
		});
	});

	test('does not spawn npm.cmd directly and requires the npm CLI path', () => {
		const command = createGulpCommand('repository', 'task', { npm_execpath: 'npm-cli.js' }, 'node.exe');
		assert.deepStrictEqual({
			executable: command.executable,
			args: command.args,
			usesCommandScript: /\.(?:cmd|bat)$/i.test(command.executable),
		}, {
			executable: 'node.exe',
			args: ['npm-cli.js', 'run', 'gulp', '--', 'task'],
			usesCommandScript: false,
		});
		assert.throws(
			() => createGulpCommand('repository', 'task', {}, 'node.exe'),
			/npm_execpath is required.*npm run vibe:package:win-arm64/
		);
	});

	test('derives output paths and executable name from repository and product name', () => {
		const repositoryRoot = path.resolve('workspace', 'vibe');
		assert.deepStrictEqual(derivePackageInfo(repositoryRoot, 'Code - OSS'), {
			repositoryRoot,
			packageDirectory: path.join(path.dirname(repositoryRoot), 'VSCode-win32-arm64'),
			applicationName: 'Code - OSS',
			applicationExecutable: path.join(path.dirname(repositoryRoot), 'VSCode-win32-arm64', 'Code - OSS.exe'),
			manifestPath: path.join(repositoryRoot, '.build', 'vibe', 'win32-arm64', 'pe-hashes.json'),
		});
	});

	test('rejects missing or invalid signer configuration', () => {
		assert.throws(() => readSigningConfiguration({}), /VIBE_WIN_CERT_SHA1 is required/);
		assert.throws(() => readSigningConfiguration({ VIBE_WIN_CERT_SHA1: 'not-a-thumbprint' }), /40-character SHA-1 certificate thumbprint/);
	});

	test('propagates failed child processes', async () => {
		await assert.rejects(runCheckedCommand({
			executable: process.execPath,
			args: ['-e', 'process.exit(7)'],
			description: 'Expected command failure',
		}), /Expected command failure failed with exit code 7/);
	});

	test('enumerates only executable, library, and native Node PE files', async () => {
		const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vibe-win-arm64-test-'));
		try {
			await fs.promises.mkdir(path.join(temporaryDirectory, 'nested'));
			await Promise.all([
				fs.promises.writeFile(path.join(temporaryDirectory, 'App.exe'), ''),
				fs.promises.writeFile(path.join(temporaryDirectory, 'runtime.DLL'), ''),
				fs.promises.writeFile(path.join(temporaryDirectory, 'App.exe.sig'), ''),
				fs.promises.writeFile(path.join(temporaryDirectory, 'readme.txt'), ''),
				fs.promises.writeFile(path.join(temporaryDirectory, 'nested', 'native.node'), ''),
			]);

			const result = (await enumeratePeFiles(temporaryDirectory))
				.map(file => path.relative(temporaryDirectory, file).replace(/\\/g, '/'));
			assert.deepStrictEqual(result, ['App.exe', 'nested/native.node', 'runtime.DLL']);
		} finally {
			await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	test('constructs non-interactive streaming EVS package commands', () => {
		const packageInfo = derivePackageInfo(path.resolve('workspace', 'vibe'), 'Code - OSS');
		const [signCommand, verifyCommand] = createEvsCommands('python', packageInfo);

		assert.deepStrictEqual({
			signCommand,
			verifyCommand,
			hasForce: [...signCommand.args, ...verifyCommand.args].includes('--force'),
		}, {
			signCommand: {
				executable: 'python',
				args: ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', '--streaming', '--name-hint', 'Code - OSS', packageInfo.packageDirectory],
				description: 'EVS VMP sign package',
				cwd: packageInfo.repositoryRoot,
				environment: { EVS_NO_ASK: '1' },
			},
			verifyCommand: {
				executable: 'python',
				args: ['-m', 'castlabs_evs.vmp', '--no-ask', 'verify-pkg', '--streaming', '--name-hint', 'Code - OSS', packageInfo.packageDirectory],
				description: 'EVS VMP verify package',
				cwd: packageInfo.repositoryRoot,
				environment: { EVS_NO_ASK: '1' },
			},
			hasForce: false,
		});
	});
});
