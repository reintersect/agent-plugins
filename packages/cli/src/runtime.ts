import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Layer } from "effect";
import { Backend } from "#backend";
import { AgentStore } from "#store";

export const AppLive = Layer.mergeAll(
  AgentStore.Default,
  Backend.Default,
  NodeHttpClient.layerUndici,
  NodeContext.layer,
);
