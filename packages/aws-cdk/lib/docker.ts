import { ContainerImageAssetMetadataEntry } from '@aws-cdk/cx-api';
import { CloudFormation } from 'aws-sdk';
import * as path from 'path';
import { ToolkitInfo } from './api/toolkit-info';
import { debug, print } from './logging';
import { shell } from './os';

/**
 * Build and upload a Docker image
 */
export async function prepareContainerAsset(assemblyDir: string,
                                            asset: ContainerImageAssetMetadataEntry,
                                            toolkitInfo: ToolkitInfo,
                                            reuse: boolean): Promise<CloudFormation.Parameter[]> {

  if (!asset.imageNameParameter) {
    if (!asset.repositoryName || !asset.imageTag) {
      throw new Error(`"repositoryName" and "imageTag" are both required if "imageParameterName" is omitted`);
    }
  }

  if (reuse) {
    // TODO?
    return [
      { ParameterKey: asset.imageNameParameter, UsePreviousValue: true },
    ];
  }

  const contextPath = path.isAbsolute(asset.path) ? asset.path : path.join(assemblyDir, asset.path);

  debug(' 👑  Preparing Docker image asset:', contextPath);

  try {
    const ecr = await toolkitInfo.prepareEcrRepository(asset);

    // if both repo name and image tag are explicitly defined, we assume the
    // image is immutable and can skip build & push.
    if (asset.repositoryName && asset.imageTag) {
      debug(`checking if ${asset.repositoryName}:${asset.imageTag} already exists`);
      if (await toolkitInfo.checkEcrImage(asset.repositoryName, asset.imageTag)) {
        debug(`image already exists, skipping`);
        return [];
      }
    }

    // we use "latest" for image tag for backwards compatibility with pre-1.21.0 apps.
    const imageTag = asset.imageTag ?? 'latest';
    const imageUri = `${ecr.repositoryUri}:${imageTag}`;

    const buildArgs = ([] as string[]).concat(...Object.entries(asset.buildArgs || {}).map(([k, v]) => ['--build-arg', `${k}=${v}`]));

    const baseCommand = [
      'docker', 'build',
      ...buildArgs,
      '--tag', imageUri,
      contextPath
    ];

    if (asset.target) {
      baseCommand.push('--target', asset.target);
    }

    if (asset.file) {
      baseCommand.push('--file', asset.file);
    }

    await shell(baseCommand);

    // Login and push
    await dockerLogin(toolkitInfo);

    // There's no way to make this quiet, so we can't use a PleaseHold. Print a header message.
    print(` ⌛ Pushing Docker image for ${contextPath}; this may take a while.`);
    await shell(['docker', 'push', imageUri]);
    debug(` 👑  Docker image for ${contextPath} pushed.`);

    // backwards compatibility with pre 1.21.0, wire imageNameParameter to the actual image name
    if (asset.imageNameParameter) {
      // Get the (single) repo-digest for latest, which'll be <ecr.repositoryUrl>@sha256:<repoImageSha256>
      const repoDigests = (await shell(['docker', 'image', 'inspect', imageUri, '--format', '{{range .RepoDigests}}{{.}}|{{end}}'])).trim();
      const requiredPrefix = `${ecr.repositoryUri}@sha256:`;
      const repoDigest = repoDigests.split('|').find(digest => digest.startsWith(requiredPrefix));
      if (!repoDigest) {
        throw new Error(`Unable to identify repository digest (none starts with ${requiredPrefix}) in:\n${repoDigests}`);
      }

      return [
        { ParameterKey: asset.imageNameParameter, ParameterValue: repoDigest.replace(ecr.repositoryUri, ecr.repositoryName) },
      ];
    }

    // no parameters needed post 1.21.0
    return [ ];
  } catch (e) {
    if (e.code === 'ENOENT') {
      // tslint:disable-next-line:max-line-length
      throw new Error('Error building Docker image asset; you need to have Docker installed in order to be able to build image assets. Please install Docker and try again.');
    }
    throw e;
  }
}

/**
 * Get credentials from ECR and run docker login
 */
async function dockerLogin(toolkitInfo: ToolkitInfo) {
  const credentials = await toolkitInfo.getEcrCredentials();
  await shell(['docker', 'login',
  '--username', credentials.username,
  '--password', credentials.password,
  credentials.endpoint]);
}
