/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import product from '../../product.json' with { type: 'json' };

const windowsArm64DestinationFolderName = 'VSCode-win32-arm64';
const peExtensions = new Set(['.exe', '.dll', '.node']);

export interface PackageInfo {
	repositoryRoot: string;
	packageDirectory: string;
	applicationName: string;
	applicationExecutable: string;
	manifestPath: string;
}

export interface SigningConfiguration {
	certificateSha1: string;
	timestampUrl?: string;
}

export interface CommandSpec {
	executable: string;
	args: string[];
	description: string;
	cwd?: string;
	environment?: NodeJS.ProcessEnv;
}

export function derivePackageInfo(repositoryRoot: string, applicationName: string): PackageInfo {
	if (!applicationName.trim()) {
		throw new Error('product.nameShort must not be empty.');
	}

	const packageDirectory = path.join(path.dirname(repositoryRoot), windowsArm64DestinationFolderName);
	return {
		repositoryRoot,
		packageDirectory,
		applicationName,
		applicationExecutable: path.join(packageDirectory, `${applicationName}.exe`),
		manifestPath: path.join(repositoryRoot, '.build', 'vibe', 'win32-arm64', 'pe-hashes.json'),
	};
}

export function readSigningConfiguration(environment: NodeJS.ProcessEnv): SigningConfiguration {
	const certificateSha1 = environment['VIBE_WIN_CERT_SHA1']?.replace(/\s/g, '');
	if (!certificateSha1) {
		throw new Error('VIBE_WIN_CERT_SHA1 is required for Windows certificate-store signing.');
	}
	if (!/^[a-f\d]{40}$/i.test(certificateSha1)) {
		throw new Error('VIBE_WIN_CERT_SHA1 must be a 40-character SHA-1 certificate thumbprint.');
	}

	const timestampUrl = environment['VIBE_WIN_TIMESTAMP_URL']?.trim();
	return {
		certificateSha1,
		timestampUrl: timestampUrl || undefined,
	};
}

export function createGulpCommand(
	repositoryRoot: string,
	taskName: string,
	environment: NodeJS.ProcessEnv = process.env,
	nodeExecutable: string = process.execPath
): CommandSpec {
	const npmExecPath = environment['npm_execpath']?.trim();
	if (!npmExecPath) {
		throw new Error('npm_execpath is required to run packaging tasks. Invoke the wrapper through npm run vibe:package:win-arm64.');
	}

	return {
		executable: nodeExecutable,
		args: [npmExecPath, 'run', 'gulp', '--', taskName],
		description: `Build task ${taskName}`,
		cwd: repositoryRoot,
		environment,
	};
}

export function createPackagingEnvironment(signToolPath: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const childEnvironment = { ...environment };
	const pathKey = Object.keys(childEnvironment).find(key => key.toLowerCase() === 'path') ?? 'PATH';
	const currentPath = childEnvironment[pathKey];
	childEnvironment[pathKey] = currentPath
		? `${path.dirname(signToolPath)}${path.delimiter}${currentPath}`
		: path.dirname(signToolPath);
	return childEnvironment;
}

export function createAuthenticodeSignCommand(signToolPath: string, configuration: SigningConfiguration, filePath: string): CommandSpec {
	const args = [
		'sign',
		'/sha1', configuration.certificateSha1,
		'/s', 'My',
		'/fd', 'SHA256',
		'/as',
	];
	if (configuration.timestampUrl) {
		args.push('/tr', configuration.timestampUrl, '/td', 'SHA256');
	}
	args.push(filePath);

	return {
		executable: signToolPath,
		args,
		description: `Authenticode sign ${path.basename(filePath)}`,
	};
}

export function createAuthenticodeVerifyCommand(signToolPath: string, filePath: string): CommandSpec {
	return {
		executable: signToolPath,
		args: ['verify', '/pa', '/all', filePath],
		description: `Authenticode verify ${path.basename(filePath)}`,
	};
}

export function createEvsCommands(pythonExecutable: string, packageInfo: PackageInfo): readonly [CommandSpec, CommandSpec] {
	const commonArgs = [
		'-m', 'castlabs_evs.vmp',
		'--no-ask',
	];
	const packageArgs = [
		'--streaming',
		'--name-hint', packageInfo.applicationName,
		packageInfo.packageDirectory,
	];
	const environment = { EVS_NO_ASK: '1' };

	return [{
		executable: pythonExecutable,
		args: [...commonArgs, 'sign-pkg', ...packageArgs],
		description: 'EVS VMP sign package',
		cwd: packageInfo.repositoryRoot,
		environment,
	}, {
		executable: pythonExecutable,
		args: [...commonArgs, 'verify-pkg', ...packageArgs],
		description: 'EVS VMP verify package',
		cwd: packageInfo.repositoryRoot,
		environment,
	}];
}

export function runCheckedCommand(command: CommandSpec): Promise<void> {
	console.log(`> ${command.description}`);
	return new Promise((resolve, reject) => {
		const child = spawn(command.executable, command.args, {
			cwd: command.cwd,
			env: { ...process.env, ...command.environment },
			stdio: 'inherit',
			windowsHide: true,
		});
		child.once('error', error => reject(new Error(`${command.description} failed to start: ${error.message}`)));
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}

			const result = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
			reject(new Error(`${command.description} failed with ${result}.`));
		});
	});
}

function getEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase());
	return key ? environment[key] : undefined;
}

function compareSdkVersionsDescending(first: string, second: string): number {
	const firstParts = first.split('.').map(part => Number.parseInt(part, 10));
	const secondParts = second.split('.').map(part => Number.parseInt(part, 10));
	for (let index = 0; index < Math.max(firstParts.length, secondParts.length); index++) {
		const difference = (secondParts[index] ?? 0) - (firstParts[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(filePath)).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function findSignToolInSdkBin(binDirectory: string, architectureNames: string[]): Promise<string | undefined> {
	for (const architecture of architectureNames) {
		const candidate = path.join(binDirectory, architecture, 'signtool.exe');
		if (await isFile(candidate)) {
			return candidate;
		}
	}

	const directCandidate = path.join(binDirectory, 'signtool.exe');
	return await isFile(directCandidate) ? directCandidate : undefined;
}

export async function discoverSignTool(environment: NodeJS.ProcessEnv, hostArchitecture: string = process.arch): Promise<string> {
	const explicitPath = getEnvironmentValue(environment, 'VIBE_WIN_SIGNTOOL_PATH')?.trim();
	if (explicitPath) {
		if (!await isFile(explicitPath)) {
			throw new Error('VIBE_WIN_SIGNTOOL_PATH does not point to an existing file.');
		}
		return path.resolve(explicitPath);
	}

	const architectureNames = hostArchitecture === 'arm64'
		? ['arm64', 'x64', 'x86']
		: hostArchitecture === 'x64'
			? ['x64', 'x86', 'arm64']
			: ['x86', 'x64', 'arm64'];
	const sdkBinDirectories = new Set<string>();
	const versionedBinPath = getEnvironmentValue(environment, 'WindowsSdkVerBinPath');
	if (versionedBinPath) {
		sdkBinDirectories.add(versionedBinPath);
	}
	const sdkBinPath = getEnvironmentValue(environment, 'WindowsSdkBinPath');
	if (sdkBinPath) {
		sdkBinDirectories.add(sdkBinPath);
	}
	const sdkDirectory = getEnvironmentValue(environment, 'WindowsSdkDir');
	const sdkVersion = getEnvironmentValue(environment, 'WindowsSDKVersion')?.replace(/[\\/]+$/, '');
	if (sdkDirectory) {
		sdkBinDirectories.add(path.join(sdkDirectory, 'bin'));
		if (sdkVersion) {
			sdkBinDirectories.add(path.join(sdkDirectory, 'bin', sdkVersion));
		}
	}

	for (const programFilesName of ['ProgramFiles(x86)', 'ProgramFiles']) {
		const programFiles = getEnvironmentValue(environment, programFilesName);
		if (programFiles) {
			sdkBinDirectories.add(path.join(programFiles, 'Windows Kits', '10', 'bin'));
		}
	}

	const pathValue = getEnvironmentValue(environment, 'PATH');
	if (pathValue) {
		for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
			const candidate = path.join(directory, 'signtool.exe');
			if (await isFile(candidate)) {
				return candidate;
			}
		}
	}

	for (const binDirectory of sdkBinDirectories) {
		const directMatch = await findSignToolInSdkBin(binDirectory, architectureNames);
		if (directMatch) {
			return directMatch;
		}

		let versions: string[];
		try {
			versions = (await fs.promises.readdir(binDirectory, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
				.map(entry => entry.name)
				.sort(compareSdkVersionsDescending);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				continue;
			}
			throw error;
		}

		for (const version of versions) {
			const versionMatch = await findSignToolInSdkBin(path.join(binDirectory, version), architectureNames);
			if (versionMatch) {
				return versionMatch;
			}
		}
	}

	throw new Error('Unable to locate signtool.exe. Install the Windows SDK or set VIBE_WIN_SIGNTOOL_PATH.');
}

export async function enumeratePeFiles(packageDirectory: string): Promise<string[]> {
	const result: string[] = [];

	async function visit(directory: string): Promise<void> {
		const entries = await fs.promises.readdir(directory, { withFileTypes: true });
		entries.sort((first, second) => first.name.localeCompare(second.name));
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
			} else if (entry.isFile() && peExtensions.has(path.extname(entry.name).toLowerCase())) {
				result.push(entryPath);
			}
		}
	}

	await visit(packageDirectory);
	return result;
}

async function sha256(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.once('error', reject);
		stream.on('data', data => hash.update(data));
		stream.once('end', () => resolve(hash.digest('hex')));
	});
}

export async function writePeHashManifest(packageInfo: PackageInfo, files: string[]): Promise<void> {
	const entries = [];
	for (const file of files) {
		entries.push({
			path: path.relative(packageInfo.packageDirectory, file).replace(/\\/g, '/'),
			sha256: await sha256(file),
		});
	}

	const manifest = {
		version: 1,
		algorithm: 'sha256',
		createdAt: new Date().toISOString(),
		applicationName: packageInfo.applicationName,
		packageDirectory: packageInfo.packageDirectory,
		applicationExecutable: path.relative(packageInfo.packageDirectory, packageInfo.applicationExecutable).replace(/\\/g, '/'),
		files: entries,
	};
	await fs.promises.mkdir(path.dirname(packageInfo.manifestPath), { recursive: true });
	await fs.promises.writeFile(packageInfo.manifestPath, `${JSON.stringify(manifest, undefined, '\t')}\n`, 'utf8');
}

async function verifyPackageOutput(packageInfo: PackageInfo): Promise<void> {
	let packageStat: fs.Stats;
	try {
		packageStat = await fs.promises.stat(packageInfo.packageDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Package directory was not created: ${packageInfo.packageDirectory}`);
		}
		throw error;
	}
	if (!packageStat.isDirectory()) {
		throw new Error(`Package output is not a directory: ${packageInfo.packageDirectory}`);
	}
	if (!await isFile(packageInfo.applicationExecutable)) {
		throw new Error(`Application executable was not created: ${packageInfo.applicationExecutable}`);
	}
}

async function main(): Promise<void> {
	if (process.platform !== 'win32') {
		throw new Error('Windows ARM64 packaging must run on Windows.');
	}

	const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
	const packageInfo = derivePackageInfo(repositoryRoot, product.nameShort);
	const signingConfiguration = readSigningConfiguration(process.env);
	const signToolPath = await discoverSignTool(process.env);
	const packagingEnvironment = createPackagingEnvironment(signToolPath, process.env);
	const pythonExecutable = process.env['VIBE_PYTHON_PATH']?.trim() || 'python';

	console.log(`Packaging ${packageInfo.applicationName} for Windows ARM64.`);
	console.log(`Unpacked output: ${packageInfo.packageDirectory}`);

	await runCheckedCommand(createGulpCommand(repositoryRoot, 'vscode-win32-arm64-min', packagingEnvironment));
	await runCheckedCommand(createGulpCommand(repositoryRoot, 'vscode-win32-arm64-inno-updater', packagingEnvironment));
	await verifyPackageOutput(packageInfo);

	const filesBeforeSigning = await enumeratePeFiles(packageInfo.packageDirectory);
	if (filesBeforeSigning.length === 0) {
		throw new Error(`No Windows PE binaries were found in ${packageInfo.packageDirectory}.`);
	}
	for (const file of filesBeforeSigning) {
		await runCheckedCommand(createAuthenticodeSignCommand(signToolPath, signingConfiguration, file));
	}
	for (const file of filesBeforeSigning) {
		await runCheckedCommand(createAuthenticodeVerifyCommand(signToolPath, file));
	}

	const [evsSignCommand, evsVerifyCommand] = createEvsCommands(pythonExecutable, packageInfo);
	await runCheckedCommand(evsSignCommand);
	await runCheckedCommand(evsVerifyCommand);

	const filesAfterVmpSigning = await enumeratePeFiles(packageInfo.packageDirectory);
	assertSamePeFiles(filesBeforeSigning, filesAfterVmpSigning);
	await writePeHashManifest(packageInfo, filesAfterVmpSigning);
	console.log(`Recorded signed PE hashes: ${packageInfo.manifestPath}`);
}

function assertSamePeFiles(before: string[], after: string[]): void {
	if (before.length !== after.length || before.some((file, index) => file !== after[index])) {
		throw new Error('The set of application PE binaries changed during EVS VMP signing.');
	}
}

if (import.meta.main) {
	main().catch(error => {
		console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
