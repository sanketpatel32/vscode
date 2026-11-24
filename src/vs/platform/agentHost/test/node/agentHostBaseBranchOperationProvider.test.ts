/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IChangesetOperationHandler, IChangesetOperationRegistry } from '../../common/agentHostChangesetOperationService.js';
import { Branch, GitRefType, IAgentHostGitService, IRefQuery } from '../../common/agentHostGitService.js';
import { IAgentHostGitStateService } from '../../common/agentHostGitStateService.js';
import { IAgentHostSessionStateStore } from '../../common/agentHostSessionStateStore.js';
import { buildBranchChangesetUri, buildUncommittedChangesetUri, ChangesetKind } from '../../common/changesetUri.js';
import { createSetBaseBranchMeta, LIST_BASE_BRANCHES_OPERATION_ID, readBaseBranchCandidatesResult, SET_BASE_BRANCH_OPERATION_ID } from '../../common/meta/agentBaseBranchOperationMeta.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { JsonRpcErrorCodes, ProtocolError } from '../../common/state/sessionProtocol.js';
import { buildChatUri, buildDefaultChatUri, ChangesetOperationScope, ChangesetOperationStatus, SessionStatus } from '../../common/state/sessionState.js';
import { AgentHostBaseBranchOperationContribution, computeBaseBranchCandidates } from '../../node/agentHostBaseBranchOperationProvider.js';
import { resolveBranchChangesetScopeForSource } from '../../node/agentHostBranchChangesetScope.js';
import { AgentHostStateManager, creationTimeChatStorageResource } from '../../node/agentHostStateManager.js';
import { createTestChatOwnershipService } from './chatOwnershipTestUtils.js';

const session = 'agent:/session';
const defaultChat = buildDefaultChatUri(session);
const sameFolderChat = buildChatUri(session, 'same-folder');
const otherFolderChat = buildChatUri(session, 'other-folder');
const repository = URI.file('/repo').toString();
const otherRepository = URI.file('/other').toString();

const branches: Branch[] = [
	{ kind: GitRefType.Head, ref: 'refs/heads/feature', name: 'feature' },
	{ kind: GitRefType.RemoteHead, ref: 'refs/remotes/origin/main', name: 'origin/main', remote: 'origin' },
	{ kind: GitRefType.Head, ref: 'refs/heads/main', name: 'main', upstream: { ref: 'refs/remotes/origin/main', name: 'origin/main', remote: 'origin' } },
	{ kind: GitRefType.RemoteHead, ref: 'refs/remotes/origin/release/1.90', name: 'origin/release/1.90', remote: 'origin' },
	{ kind: GitRefType.RemoteHead, ref: 'refs/remotes/upstream/fix', name: 'upstream/fix', remote: 'upstream' },
	{ kind: GitRefType.Head, ref: 'refs/heads/fix', name: 'fix' },
];

async function errorCode(promise: Promise<unknown>): Promise<number | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ProtocolError ? error.code : -1;
	}
	return undefined;
}

suite('AgentHostBaseBranchOperationContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness() {
		const stateManager = disposables.add(new AgentHostStateManager(new NullLogService()));
		stateManager.createSession({
			resource: session,
			provider: 'copilot',
			title: 'Session',
			status: SessionStatus.Idle,
			createdAt: new Date(1).toISOString(),
			modifiedAt: new Date(1).toISOString(),
			workingDirectories: [repository],
			defaultChat,
		});
		stateManager.addChat(session, sameFolderChat, creationTimeChatStorageResource(session, sameFolderChat, defaultChat));
		stateManager.addChat(session, otherFolderChat, creationTimeChatStorageResource(session, otherFolderChat, defaultChat), { workingDirectories: [otherRepository] });

		const gitCalls: string[] = [];
		const gitService = new class extends mock<IAgentHostGitService>() {
			override async getRepositoryRoot(workingDirectory: URI): Promise<URI | undefined> {
				return workingDirectory;
			}
			override async getBranches(workingDirectory: URI, query?: IRefQuery): Promise<Branch[]> {
				gitCalls.push(`getBranches:${workingDirectory.toString()}:${query?.pattern}:${query?.sort}`);
				return branches;
			}
			override async getDefaultBranch2(): Promise<Branch | undefined> {
				return branches[2];
			}
		}();
		const chatRefreshes: string[] = [];
		const gitStateService = new class extends mock<IAgentHostGitStateService>() {
			override async refreshSessionGitState(sessionKey: string): Promise<void> {
				chatRefreshes.push(sessionKey);
			}
		}();
		const writes: { session: string; target: string; values: Readonly<Record<string, string | null>> }[] = [];
		const sessionStateStore = new class extends mock<IAgentHostSessionStateStore>() {
			override async writeMetadata(session: URI, resource: URI, values: Readonly<Record<string, string | null>>): Promise<void> {
				writes.push({ session: session.toString(), target: resource.toString(), values });
			}
		}();
		const contribution = disposables.add(new AgentHostBaseBranchOperationContribution(
			stateManager,
			createTestChatOwnershipService(stateManager),
			gitService,
			gitStateService,
			sessionStateStore,
			new NullLogService(),
		));

		const handlers = new Map<string, IChangesetOperationHandler>();
		const registryRefreshes: string[] = [];
		const registry: IChangesetOperationRegistry = {
			registerChangesetOperationHandler: (operationId, handler) => {
				handlers.set(operationId, handler);
				return toDisposable(() => handlers.delete(operationId));
			},
			onDidChangeOperations: () => { },
			refreshSessionGitState: async sessionKey => { registryRefreshes.push(sessionKey); },
		};
		disposables.add(contribution.registerHandlers(registry));

		const branchChangeset = (chat: string) => buildBranchChangesetUri(resolveBranchChangesetScopeForSource(stateManager, chat).ownerUri);
		const invoke = (operationId: string, chat: string, meta?: Record<string, unknown>) => handlers.get(operationId)!.invoke({ channel: branchChangeset(chat), operationId, _meta: meta }, CancellationToken.None);
		return { stateManager, contribution, gitCalls, chatRefreshes, writes, registryRefreshes, branchChangeset, invoke };
	}

	test('base branch candidates exclude local branches with an origin twin, keeping their order', () => {
		assert.deepStrictEqual([
			computeBaseBranchCandidates(branches, 'origin/main'),
			computeBaseBranchCandidates(branches, 'main'),
		], [
			{ branches: ['feature', 'origin/main', 'origin/release/1.90', 'upstream/fix', 'fix'], defaultBranch: 'origin/main' },
			{ branches: ['feature', 'origin/main', 'origin/release/1.90', 'upstream/fix', 'fix'] },
		]);
	});

	test('lists the candidates of the changeset folder, most recently committed first, with the default branch', async () => {
		const h = createHarness();

		const result = await h.invoke(LIST_BASE_BRANCHES_OPERATION_ID, defaultChat);

		assert.deepStrictEqual({ candidates: readBaseBranchCandidatesResult(result), gitCalls: h.gitCalls }, {
			candidates: { branches: ['feature', 'origin/main', 'origin/release/1.90', 'upstream/fix', 'fix'], defaultBranch: 'origin/main' },
			gitCalls: [`getBranches:${repository}:refs/heads,refs/remotes:committerdate`],
		});
	});

	test('records the requested base exactly for the changeset source and refreshes every chat in the folder', async () => {
		const h = createHarness();

		const results = [
			await h.invoke(SET_BASE_BRANCH_OPERATION_ID, defaultChat, createSetBaseBranchMeta('origin/release/1.90')),
			await h.invoke(SET_BASE_BRANCH_OPERATION_ID, otherFolderChat, createSetBaseBranchMeta('upstream/fix')),
		];
		const errors = [
			await errorCode(h.invoke(SET_BASE_BRANCH_OPERATION_ID, defaultChat)),
			await errorCode(h.invoke(SET_BASE_BRANCH_OPERATION_ID, defaultChat, createSetBaseBranchMeta('main'))),
		];

		assert.deepStrictEqual({ results, errors, writes: h.writes, registryRefreshes: h.registryRefreshes, chatRefreshes: h.chatRefreshes }, {
			results: [{}, {}],
			errors: [JsonRpcErrorCodes.InvalidParams, JsonRpcErrorCodes.InvalidParams],
			writes: [
				{ session, target: session, values: { 'agentHost.diffBaseBranch': 'origin/release/1.90' } },
				{ session, target: otherFolderChat, values: { 'agentHost.diffBaseBranch': 'upstream/fix' } },
			],
			registryRefreshes: [
				resolveBranchChangesetScopeForSource(h.stateManager, defaultChat).ownerUri,
				resolveBranchChangesetScopeForSource(h.stateManager, otherFolderChat).ownerUri,
			],
			chatRefreshes: [sameFolderChat],
		});
	});

	test('advertises the operations on Branch Changes only where the diff reads the recorded base', () => {
		const h = createHarness();
		const operationIds = (changesetUri: string, changesetKind: ChangesetKind) =>
			h.contribution.getOperations({ sessionKey: session, changesetUri, changesetKind })?.map(operation => operation.id);

		const branchOperations = h.contribution.getOperations({ sessionKey: session, changesetUri: h.branchChangeset(defaultChat), changesetKind: ChangesetKind.Branch });
		const uncommitted = operationIds(buildUncommittedChangesetUri(defaultChat), ChangesetKind.Uncommitted);
		h.stateManager.dispatchServerAction(defaultChat, { type: ActionType.ChatWorkingDirectorySet, directory: URI.file('/worktree').toString() });
		const defaultChatOutsideSessionFolder = operationIds(h.branchChangeset(defaultChat), ChangesetKind.Branch);
		const peerOutsideSessionFolder = operationIds(h.branchChangeset(otherFolderChat), ChangesetKind.Branch);

		assert.deepStrictEqual({ branchOperations, uncommitted, defaultChatOutsideSessionFolder, peerOutsideSessionFolder }, {
			branchOperations: [{
				id: LIST_BASE_BRANCHES_OPERATION_ID,
				label: 'List Base Branches',
				description: 'List the branches that Branch Changes can compare against.',
				group: 'base-branch',
				scopes: [ChangesetOperationScope.Changeset],
				status: ChangesetOperationStatus.Idle,
			}, {
				id: SET_BASE_BRANCH_OPERATION_ID,
				label: 'Change Base Branch',
				description: 'Compare Branch Changes against another branch.',
				group: 'base-branch',
				scopes: [ChangesetOperationScope.Changeset],
				status: ChangesetOperationStatus.Idle,
			}],
			uncommitted: undefined,
			defaultChatOutsideSessionFolder: undefined,
			peerOutsideSessionFolder: [LIST_BASE_BRANCHES_OPERATION_ID, SET_BASE_BRANCH_OPERATION_ID],
		});
	});
});
