import assert from "node:assert/strict";
import os from "node:os";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

type LoadOptions = Parameters<typeof loadSubagentSpawnModuleForTest>[0];
type BindingService = ReturnType<NonNullable<LoadOptions["getSessionBindingService"]>>;
const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const registerSubagentRunMock = vi.fn();
const requireRecord = createRequireRecord("record", "expected-non-array-record");
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let pluginRuntime: typeof import("../../../plugins/runtime.js");
let pluginFixtures: typeof import("../../../test-utils/channel-plugins.js");
let config: Record<string, unknown>;
let bindingService: BindingService;
let routable = true;
let resolveTarget: NonNullable<LoadOptions["resolveConversationDeliveryTarget"]>;
const caller = {
  agentSessionKey: "agent:main:main",
  agentChannel: "matrix",
  agentTo: "room:parent",
};
function agentParams() {
  return requireRecord(
    callGatewayMock.mock.calls.find(([call]) => call.method === "agent")?.[0].params,
  );
}
function registered() {
  return requireRecord(registerSubagentRunMock.mock.calls[0]?.[0]);
}
function makeBindingService(
  bind: BindingService["bind"],
  listBySession: BindingService["listBySession"] = () => [],
): BindingService {
  return {
    getCapabilities: () => ({ adapterAvailable: true, bindSupported: true, placements: ["child"] }),
    bind,
    listBySession,
  };
}

describe("spawnSubagentDirect thread binding", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock,
      registerSubagentRunMock,
      getRuntimeConfig: () => config,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      getSessionBindingService: () => bindingService,
      resolveConversationDeliveryTarget: (params) => resolveTarget(params),
    }));
    pluginRuntime = await import("../../../plugins/runtime.js");
    pluginFixtures = await import("../../../test-utils/channel-plugins.js");
  });
  beforeEach(() => {
    routable = true;
    callGatewayMock.mockReset();
    registerSubagentRunMock.mockReset();
    updateSessionStoreMock.mockReset();
    installAcceptedSubagentGatewayMock(callGatewayMock);
    installSessionStoreCaptureMock(updateSessionStoreMock);
    config = createSubagentSpawnTestConfig(os.tmpdir(), {
      agents: { list: [{ id: "main", workspace: "/tmp/workspace-main" }] },
      session: { threadBindings: { defaultSpawnContext: "isolated" } },
    });
    bindingService = makeBindingService(async (request) => ({
      targetSessionKey: request.targetSessionKey,
      targetKind: request.targetKind,
      status: "active",
      conversation: request.conversation,
    }));
    resolveTarget = ({ conversationId }) => ({
      to: conversationId ? `channel:${String(conversationId)}` : undefined,
    });
    pluginRuntime.setActivePluginRegistry(
      pluginFixtures.createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...pluginFixtures.createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) => {
                if (!routable) {
                  return {};
                }
                const parent = parentConversationId?.trim();
                const child = conversationId.trim();
                return parent && parent !== child
                  ? { to: `room:${parent}`, threadId: child }
                  : { to: `room:${child}` };
              },
            },
          },
        },
      ]),
    );
  });

  it.each([
    { mode: "run", thread: false, route: true, announce: false, cleanup: "delete" },
    { mode: "run", thread: true, route: true, announce: true, cleanup: "keep" },
    { mode: "session", thread: true, route: false, announce: true, cleanup: "keep" },
  ] as const)(
    "aligns $mode thread=$thread route=$route guidance and delivery",
    async ({ mode, thread, route, announce, cleanup }) => {
      routable = route;
      const result = await spawnSubagentDirect(
        { task: "Return findings", mode, thread, expectsCompletionMessage: announce, cleanup },
        caller,
      );
      expect(result.status).toBe("accepted");
      expect(agentParams().deliver).toBe(false);
      expect(result.expectsCompletionMessage).toBe(announce);
      expect(registered().expectsCompletionMessage).toBe(announce);
      const { extraSystemPrompt, message } = agentParams();
      assert(typeof extraSystemPrompt === "string", "child system prompt must be text");
      assert(typeof message === "string", "child task must be text");
      const guidance = `${extraSystemPrompt}\n${message}`;
      const contract = announce ? /completion event/i : /no completion notification/i;
      expect(guidance).toMatch(contract);
      expect(result.note).toMatch(contract);
      if (cleanup === "delete") {
        expect(registered()).toMatchObject({ cleanup: "delete" });
        expect(guidance).not.toContain("remains in the child session");
        expect(result.note).not.toContain("remains in the child session");
        expect(guidance).not.toMatch(/final auto-reported|Results auto-announce/);
        expect(result.note).not.toMatch(/Auto-announce is push-based/);
      }
    },
  );

  it.each([false, true])(
    "routes bound delivery separately from requester origin (generic=%s)",
    async (generic) => {
      const conversation = generic
        ? { channel: "collabchat", accountId: "work", conversationId: "collab_dm_1" }
        : {
            channel: "matrix",
            accountId: "bot-alpha",
            conversationId: "$thread-root",
            parentConversationId: "!room:example.org",
          };
      const bind = vi.fn<NonNullable<BindingService["bind"]>>(async (request) => ({
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation,
      }));
      bindingService = makeBindingService(bind, () =>
        generic ? [{ status: "active", conversation }] : [],
      );
      if (generic) {
        resolveTarget = () => ({ to: "channel:collab_dm_1" });
      } else {
        config = createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["bot-alpha"] } },
            list: [
              { id: "main", workspace: "/tmp/workspace-main" },
              { id: "bot-alpha", workspace: "/tmp/workspace-bot-alpha" },
            ],
          },
          bindings: [
            {
              type: "route",
              agentId: "bot-alpha",
              match: {
                channel: "matrix",
                peer: { kind: "channel", id: "!room:example.org" },
                accountId: "bot-alpha",
              },
            },
          ],
        });
      }
      const result = await spawnSubagentDirect(
        {
          task: "reply with a marker",
          agentId: generic ? undefined : "bot-alpha",
          thread: true,
          mode: "session",
          context: "isolated",
        },
        {
          ...caller,
          agentAccountId: "bot-beta",
          agentTo: "room:!room:example.org",
        },
      );
      expect(result.status).toBe("accepted");
      expect(bind).toHaveBeenCalledOnce();
      if (!generic) {
        expect(bind.mock.calls[0]?.[0].conversation).toMatchObject({
          channel: "matrix",
          accountId: "bot-alpha",
          conversationId: "!room:example.org",
        });
      }
      expect(agentParams()).toMatchObject({
        channel: conversation.channel,
        accountId: conversation.accountId,
        to: generic ? "channel:collab_dm_1" : "room:!room:example.org",
        deliver: true,
        ...(generic ? {} : { threadId: "$thread-root" }),
      });
      expect(registered()).toMatchObject({
        requesterOrigin: { channel: "matrix", accountId: "bot-beta", to: "room:!room:example.org" },
        expectsCompletionMessage: false,
        spawnMode: "session",
      });
      expect(result.note).toMatch(/directly to the bound thread/i);
      expect(agentParams().extraSystemPrompt).toMatch(/directly to the bound thread/i);
    },
  );

  it("preserves lifecycle cleanup after thread registration fails", async () => {
    registerSubagentRunMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    const result = await spawnSubagentDirect(
      { task: "fail after binding", thread: true, mode: "session", context: "isolated" },
      caller,
    );
    expect(result).toMatchObject({
      status: "error",
      error: "Failed to register subagent run: registry unavailable",
      runId: "run-1",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        scopes: ["operator.admin"],
        params: expect.objectContaining({
          key: result.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
        }),
      }),
    );
  });

  it("binds a CLI-runtime thread spawn from currentChannelId when agentTo is absent", async () => {
    // claude-cli loopback tool calls identify the conversation via
    // currentChannelId/currentThreadTs and never set agentTo. Thread binding
    // previously read agentTo alone and failed even though delivery already used
    // currentChannelId (issue #158945).
    const bindCalls: Array<Record<string, unknown>> = [];
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => {
        bindCalls.push(request as unknown as Record<string, unknown>);
        return {
          targetSessionKey: request.targetSessionKey,
          targetKind: request.targetKind,
          status: "active",
          conversation: {
            channel: request.conversation.channel,
            accountId: request.conversation.accountId,
            conversationId: "$thread-root",
            parentConversationId: request.conversation.conversationId,
          },
        };
      },
      listBySession: () => [],
    };

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: undefined,
        agentThreadId: undefined,
        currentMessagingTarget: undefined,
        currentChannelId: "room:parent",
        currentThreadTs: undefined,
      },
    );

    expect(result.status).toBe("accepted");
    expect(bindCalls).toHaveLength(1);
    const bindingConversation = bindCalls[0]?.conversation as
      | { channel?: string; accountId?: string; conversationId?: string }
      | undefined;
    expect(bindingConversation?.channel).toBe("matrix");
    expect(bindingConversation?.conversationId).toBe("parent");
    const registeredRun = firstRegisteredSubagentRun();
    expect(registeredRun?.requesterOrigin?.channel).toBe("matrix");
    expect(registeredRun?.requesterOrigin?.to).toBe("room:parent");
  });

  it("rejects a CLI-runtime thread spawn before binding when spawns are disabled for the current channel", async () => {
    // The wider CLI origin (currentChannelId with no agentTo) must still pass
    // through the same channel thread-binding authority gate as agentTo origins:
    // when thread-bound spawns are disabled for the resolved channel, the bind
    // service must never be reached.
    const sessionConfig = currentConfig.session as
      | { threadBindings?: { spawnSessions?: boolean } }
      | undefined;
    currentConfig.session = {
      ...sessionConfig,
      threadBindings: { ...sessionConfig?.threadBindings, spawnSessions: false },
    };
    const bindCalls: Array<Record<string, unknown>> = [];
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => {
        bindCalls.push(request as unknown as Record<string, unknown>);
        throw new Error("bind must not be reached when spawns are disabled");
      },
      listBySession: () => [],
    };

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: undefined,
        agentThreadId: undefined,
        currentMessagingTarget: undefined,
        currentChannelId: "room:parent",
        currentThreadTs: undefined,
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Thread-bound session spawns are disabled for matrix");
    }
    expect(bindCalls).toHaveLength(0);
    expect(hoisted.registerSubagentRunMock.mock.calls).toHaveLength(0);
  });

  it("does not bind a CLI-runtime thread spawn into a conversation the channel rejects for the caller", async () => {
    // The generic loopback path lets a caller supply x-openclaw-current-channel-id.
    // Conversation authority is owned by the channel: its
    // resolveInboundConversation is the final arbiter of whether the caller may
    // bind in that conversation. When it rejects the target (a conversation the
    // caller cannot access), prepareSpawnThreadBinding must fail resolution and
    // never reach the binding service, even though thread spawning is enabled.
    const allowedRooms = new Set(["parent"]);
    setActivePluginRegistryForTest(
      createTestRegistryForTest([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createChannelTestPluginBaseForTest({ id: "matrix", label: "Matrix" }),
            messaging: {
              resolveInboundConversation: ({ to }: { to?: string }) => {
                const roomId = to?.trim().replace(/^(?:matrix:)?(?:channel:|room:)/iu, "");
                return roomId && allowedRooms.has(roomId) ? { conversationId: roomId } : null;
              },
              resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
                to: `room:${conversationId}`,
              }),
            },
          },
        },
      ]),
    );
    const bindCalls: Array<Record<string, unknown>> = [];
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => {
        bindCalls.push(request as unknown as Record<string, unknown>);
        throw new Error("bind must not be reached when the channel rejects the conversation");
      },
      listBySession: () => [],
    };

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: undefined,
        agentThreadId: undefined,
        currentMessagingTarget: undefined,
        currentChannelId: "room:not-a-conversation-for-this-caller",
        currentThreadTs: undefined,
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Could not resolve a matrix conversation");
    }
    expect(bindCalls).toHaveLength(0);
    expect(hoisted.registerSubagentRunMock.mock.calls).toHaveLength(0);
  });
  it("does not bind a caller-token loopback thread spawn to a caller-selected room", async () => {
    // Security (issue #158945 review P1): on the generic token loopback surface
    // currentChannelId/currentThreadTs are caller-writable headers. They may drive
    // delivery, but must not be authority for the child-thread binding target.
    // With no explicit host-minted agentTo, binding must fail closed before the
    // binding service (and therefore before any channel bind message), even when
    // the channel would otherwise accept the room and thread spawning is enabled.
    const bindCalls: Array<Record<string, unknown>> = [];
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => {
        bindCalls.push(request as unknown as Record<string, unknown>);
        throw new Error("bind must not be reached for a caller-token-selected room");
      },
      listBySession: () => [],
    };

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: undefined,
        agentThreadId: undefined,
        currentMessagingTarget: "room:ambient",
        currentChannelId: "room:scope-shopped",
        currentThreadTs: "456",
        currentConversationOrigin: "caller-token",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(
        /not running on a channel|Could not resolve a matrix conversation/,
      );
    }
    expect(bindCalls).toHaveLength(0);
    expect(hoisted.registerSubagentRunMock.mock.calls).toHaveLength(0);
  });

  it("binds a run-bound-grant CLI thread spawn from the immutable current channel", async () => {
    // The reported issue path: a Gateway-launched CLI carries currentChannelId in
    // an immutable run-bound grant (provenance run-bound-grant), never agentTo.
    // That current channel is trusted and thread binding must still succeed.
    const bindCalls: Array<Record<string, unknown>> = [];
    currentSessionBindingService = {
      getCapabilities: () => ({
        adapterAvailable: true,
        bindSupported: true,
        placements: ["child"],
      }),
      bind: async (request) => {
        bindCalls.push(request as unknown as Record<string, unknown>);
        return {
          targetSessionKey: request.targetSessionKey,
          targetKind: request.targetKind,
          status: "active",
          conversation: {
            channel: request.conversation.channel,
            accountId: request.conversation.accountId,
            conversationId: "$thread-root",
            parentConversationId: request.conversation.conversationId,
          },
        };
      },
      listBySession: () => [],
    };

    const result = await spawnSubagentDirect(
      {
        task: "reply with a marker",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: undefined,
        agentThreadId: undefined,
        currentMessagingTarget: undefined,
        currentChannelId: "room:parent",
        currentThreadTs: undefined,
        currentConversationOrigin: "run-bound-grant",
      },
    );

    expect(result.status).toBe("accepted");
    expect(bindCalls).toHaveLength(1);
    const bindingConversation = bindCalls[0]?.conversation as
      | { channel?: string; conversationId?: string }
      | undefined;
    expect(bindingConversation?.channel).toBe("matrix");
    expect(bindingConversation?.conversationId).toBe("parent");
  });
});
