/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isObject } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import type { InvokeChangesetOperationResult } from '../../state/protocol/channels-changeset/commands.js';
import { JsonRpcErrorCodes, ProtocolError } from '../../state/sessionProtocol.js';

/** Lists the branches a Branch changeset can compare against, without changing anything. */
export const LIST_BASE_BRANCHES_OPERATION_ID = 'list-base-branches';
/** Compares a Branch changeset against the branch named by {@link createSetBaseBranchMeta}. */
export const SET_BASE_BRANCH_OPERATION_ID = 'set-base-branch';

const BASE_BRANCH_META_KEY = 'vscode.baseBranch';
const CANDIDATES_DATA_URI_PREFIX = 'data:application/json,';

/** The branches a Branch changeset can compare against. */
export interface IBaseBranchCandidates {
	/** Branch names, exactly as the base is recorded and shown (for example `origin/main`), most recently committed first. */
	readonly branches: readonly string[];
	/** The base a new session of the repository starts from, when the repository has a default branch. */
	readonly defaultBranch?: string;
}

interface IHasBaseBranchOperationMeta {
	readonly _meta?: Record<string, unknown>;
}

/** Creates request metadata for a {@link SET_BASE_BRANCH_OPERATION_ID} operation. */
export function createSetBaseBranchMeta(branch: string): Record<string, unknown> {
	return { [BASE_BRANCH_META_KEY]: branch };
}

/**
 * Reads the branch requested by a {@link SET_BASE_BRANCH_OPERATION_ID} operation.
 * The value is client-supplied: callers must still check it is a candidate.
 */
export function readSetBaseBranchMeta(source: IHasBaseBranchOperationMeta): string | undefined {
	const meta = source._meta;
	if (meta === undefined) {
		return undefined;
	}
	if (!isRecord(meta)) {
		throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, localize('agentHost.baseBranch.invalidMeta', "Invalid base branch operation metadata."));
	}
	const branch = Object.hasOwn(meta, BASE_BRANCH_META_KEY) ? meta[BASE_BRANCH_META_KEY] : undefined;
	return typeof branch === 'string' && branch.length > 0 ? branch : undefined;
}

/** Serializes the candidates of a {@link LIST_BASE_BRANCHES_OPERATION_ID} operation using the protocol's content reference. */
export function createBaseBranchCandidatesResult(candidates: IBaseBranchCandidates): InvokeChangesetOperationResult {
	return {
		followUp: {
			content: {
				uri: `${CANDIDATES_DATA_URI_PREFIX}${encodeURIComponent(JSON.stringify(parseCandidates(candidates)))}`,
				contentType: 'application/json',
			},
		},
	};
}

export function readBaseBranchCandidatesResult(result: InvokeChangesetOperationResult): IBaseBranchCandidates {
	const followUp = result.followUp;
	const content = followUp?.content;
	if ((followUp?.external !== undefined && followUp.external !== false)
		|| content?.contentType !== 'application/json' || typeof content.uri !== 'string'
		|| !content.uri.startsWith(CANDIDATES_DATA_URI_PREFIX)) {
		throw invalidCandidates();
	}
	let candidates: unknown;
	try {
		candidates = JSON.parse(decodeURIComponent(content.uri.slice(CANDIDATES_DATA_URI_PREFIX.length)));
	} catch {
		throw invalidCandidates();
	}
	return parseCandidates(candidates);
}

function invalidCandidates(): Error {
	return new Error(localize('agentHost.baseBranch.invalidCandidates', "Invalid base branch list."));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value);
}

function isBranchName(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function parseCandidates(value: unknown): IBaseBranchCandidates {
	if (!isRecord(value) || !Array.isArray(value.branches) || !value.branches.every(isBranchName)
		|| (value.defaultBranch !== undefined && !isBranchName(value.defaultBranch))) {
		throw invalidCandidates();
	}
	return {
		branches: [...value.branches],
		...(value.defaultBranch !== undefined ? { defaultBranch: value.defaultBranch } : {}),
	};
}
