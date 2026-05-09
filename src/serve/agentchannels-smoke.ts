// -----------------------------------------------------------------------
// src/serve/agentchannels-smoke.ts
//
// Typecheck-only smoke module for the `agentchannels` workspace dependency.
//
// PURPOSE
// -------
// Sub-AC 1.4 of the Slack-aweek integration seed: prove that the local
// `agentchannels` workspace dep at `../../agentchannels/agentchannels`
// (branch `aweek-integration`) resolves end-to-end through aweek's
// existing `pnpm typecheck` gate (`tsc --noEmit -p tsconfig.node.json`).
//
// The three named exports referenced below are the public surface that
// the upcoming Slack listener inside `aweek serve` will consume:
//
//   - `SlackAdapter`     — Socket-Mode WebSocket bridge between Slack
//                          and an agentchannels `StreamingBridge`.
//   - `StreamingBridge`  — pipes `AgentStreamEvent`s from a `Backend`
//                          implementation back into a `ChannelAdapter`.
//   - `SlackManifestAPI` — Slack `apps.manifest.create` /
//                          `apps.connections.open` client used by the
//                          forthcoming `aweek slack-init` skill to
//                          provision a bot app from a manifest.
//
// This file does NOT execute at runtime. It is included only by
// `tsconfig.node.json`'s typecheck pass (see the explicit include line
// added in the same change). Importing the symbols and re-asserting
// their TypeScript shape is enough to prove:
//
//   1. pnpm resolves `agentchannels` to the workspace path
//      (`file:../../agentchannels/agentchannels`).
//   2. `agentchannels`'s published `dist/index.d.ts` is reachable from
//      aweek's tsc `moduleResolution: NodeNext` setup.
//   3. The three concrete identifiers exist on the public surface and
//      are not accidentally treated as `any`.
//
// SCOPE
// -----
// v1 only. Future sub-ACs will add the real Slack listener, per-thread
// Backend implementation, and persistence under `.aweek/channels/slack/`.
// Once those land and import these symbols from real call sites, this
// smoke file can be deleted — but until then it is the only consumer of
// `agentchannels` in aweek and serves as the early-warning signal if
// the workspace dep ever drifts out of resolution.
// -----------------------------------------------------------------------

import {
  SlackAdapter,
  StreamingBridge,
  SlackManifestAPI,
} from 'agentchannels';

// Type-only assertion: bind each runtime symbol to a `typeof` reference
// so the typechecker is forced to resolve its declaration. If any of
// these names disappear from the `agentchannels` public surface, this
// file fails `pnpm typecheck` immediately.
type SlackAdapterCtor = typeof SlackAdapter;
type StreamingBridgeCtor = typeof StreamingBridge;
type SlackManifestAPICtor = typeof SlackManifestAPI;

// Compile-time-only marker. Exported so tsc treats this file as an
// ES module (matching `tsconfig.node.json`'s `moduleDetection: force`)
// and so a future call site can import it for an even louder failure
// if the workspace dep regresses. Not used at runtime — the file is
// never imported by `server.ts` or any other production module.
export type AgentchannelsSmokeSurface = {
  readonly SlackAdapter: SlackAdapterCtor;
  readonly StreamingBridge: StreamingBridgeCtor;
  readonly SlackManifestAPI: SlackManifestAPICtor;
};
