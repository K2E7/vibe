/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';

export const supportedElectronBaseVersion = '42.8.0';
export const supportedEcsElectronVersion = '42.8.0+wvcus';

const castlabsReleaseBaseUrl = `https://github.com/castlabs/electron-releases/releases/download/v${supportedEcsElectronVersion}`;
const castlabsElectronAsset = `electron-v${supportedEcsElectronVersion}-win32-arm64.zip`;
const castlabsChecksumFile = path.join(import.meta.dirname, '..', 'checksums', 'electron-castlabs.txt');
const castlabsReleaseAssets = new Set([castlabsElectronAsset, 'SHASUMS256.txt']);

type ElectronAssetResolver = (asset: { url: string; fileName: string }) => Promise<Response>;

export interface ElectronDownloadOverrides {
	version?: string;
	repo?: ElectronAssetResolver;
	checksumFile?: string;
}

function isEcsTarget(platform: string, arch: string): boolean {
	return platform === 'win32' && arch === 'arm64';
}

/**
 * Returns the Electron runtime version for a target, failing when the explicit Castlabs mapping
 * has not been updated for the upstream Electron version.
 */
export function getVibeElectronVersion(upstreamVersion: string, platform: string, arch: string): string {
	if (!isEcsTarget(platform, arch)) {
		return upstreamVersion;
	}

	if (upstreamVersion !== supportedElectronBaseVersion) {
		throw new Error(
			`Unsupported upstream Electron version '${upstreamVersion}' for Vibe win32-arm64. ` +
			`The Castlabs ECS mapping currently supports Electron '${supportedElectronBaseVersion}' as '${supportedEcsElectronVersion}'. ` +
			'Update the Castlabs ECS mapping and checksum before continuing.'
		);
	}

	return supportedEcsElectronVersion;
}

const castlabsAssetResolver: ElectronAssetResolver = async ({ fileName }) => {
	if (!castlabsReleaseAssets.has(fileName)) {
		throw new Error(`Unexpected Castlabs Electron release asset '${fileName}' requested for Vibe win32-arm64.`);
	}

	return fetch(`${castlabsReleaseBaseUrl}/${fileName}`);
};

/**
 * Returns the target-specific overrides for Electron acquisition. All non-Windows-ARM64 targets
 * retain the upstream Electron download configuration.
 */
export function getVibeElectronDownloadOverrides(upstreamVersion: string, platform: string, arch: string): ElectronDownloadOverrides {
	const version = getVibeElectronVersion(upstreamVersion, platform, arch);
	if (!isEcsTarget(platform, arch)) {
		return {};
	}

	return {
		version,
		repo: castlabsAssetResolver,
		checksumFile: castlabsChecksumFile,
	};
}
