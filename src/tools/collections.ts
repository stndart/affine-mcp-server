import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as Y from "yjs";

import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "../ws.js";

const WorkspaceId = z.string().min(1, "workspaceId required");
const CollectionId = z.string().min(1, "collectionId required");
const JsonObject = z.record(z.any());
const JsonArray = z.array(z.any());

type CollectionRecord = Record<string, unknown> & {
  id: string;
  name?: string | null;
  allowList?: string[];
  rules?: Record<string, unknown> | null;
};

type LoadedWorkspaceRoot = {
  socket: Awaited<ReturnType<typeof connectWorkspaceSocket>>;
  doc: Y.Doc;
  prevStateVector: Uint8Array;
};

function generateId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = "";
  for (let i = 0; i < 10; i += 1) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function getYMap(target: Y.Map<any>, key: string): Y.Map<any> | null {
  const value = target.get(key);
  return value instanceof Y.Map ? value : null;
}

function ensureYMap(target: Y.Map<any>, key: string): Y.Map<any> {
  const existing = getYMap(target, key);
  if (existing) {
    return existing;
  }
  const created = new Y.Map<any>();
  target.set(key, created);
  return created;
}

function getCollectionsArray(rootDoc: Y.Doc): Y.Array<any> | null {
  const collections = rootDoc.getMap("setting").get("collections");
  return collections instanceof Y.Array ? collections : null;
}

function ensureCollectionsArray(rootDoc: Y.Doc): Y.Array<any> {
  const setting = rootDoc.getMap("setting");
  const existing = setting.get("collections");
  if (existing instanceof Y.Array) {
    return existing;
  }
  const created = new Y.Array<any>();
  setting.set("collections", created);
  return created;
}

function yValueToJson(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of value.entries()) {
      out[key] = yValueToJson(entryValue);
    }
    return out;
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((entry) => yValueToJson(entry));
  }
  if (value instanceof Y.Text) {
    return value.toString();
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAllowList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeCollection(record: Record<string, unknown>): CollectionRecord | null {
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return null;
  }

  const rulesRecord = asRecord(record.rules);
  const filters = Array.isArray(rulesRecord?.filters) ? cloneJson(rulesRecord.filters) : undefined;

  return {
    ...record,
    id: record.id,
    name: typeof record.name === "string" ? record.name : null,
    allowList: normalizeAllowList(record.allowList),
    rules: rulesRecord ? cloneJson(rulesRecord) : null,
    ...(filters ? { filters } : {}),
  };
}

function listCollections(collections: Y.Array<any>): CollectionRecord[] {
  const parsed: CollectionRecord[] = [];
  collections.forEach((entry: unknown) => {
    const record = asRecord(yValueToJson(entry));
    if (!record) {
      return;
    }
    const normalized = normalizeCollection(record);
    if (normalized) {
      parsed.push(normalized);
    }
  });
  return parsed.sort((a, b) => {
    const nameCompare = (a.name || "").localeCompare(b.name || "");
    return nameCompare !== 0 ? nameCompare : a.id.localeCompare(b.id);
  });
}

function findCollection(collections: Y.Array<any>, collectionId: string): { index: number; collection: CollectionRecord } | null {
  for (let index = 0; index < collections.length; index += 1) {
    const record = asRecord(yValueToJson(collections.get(index)));
    if (!record) {
      continue;
    }
    const normalized = normalizeCollection(record);
    if (normalized?.id === collectionId) {
      return { index, collection: normalized };
    }
  }
  return null;
}

async function loadWorkspaceRoot(gql: GraphQLClient, workspaceId: string): Promise<LoadedWorkspaceRoot> {
  const endpoint = gql.endpoint;
  const cookie = gql.cookie;
  const bearer = gql.bearer;
  const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
  const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);

  await joinWorkspace(socket, workspaceId);
  const snapshot = await loadDoc(socket, workspaceId, workspaceId);
  if (!snapshot.missing) {
    socket.disconnect();
    throw new Error(`Workspace root document not found for workspace ${workspaceId}`);
  }

  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

  return {
    socket,
    doc,
    prevStateVector: Y.encodeStateVector(doc),
  };
}

async function saveWorkspaceRoot(socket: LoadedWorkspaceRoot["socket"], workspaceId: string, doc: Y.Doc, prevStateVector: Uint8Array) {
  const delta = Y.encodeStateAsUpdate(doc, prevStateVector);
  if (delta.length === 0) {
    return;
  }
  await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(delta).toString("base64"));
}

function applyCollectionChanges(
  collection: CollectionRecord,
  input: {
    name?: string;
    allowList?: string[];
    rules?: Record<string, unknown>;
    filters?: unknown[];
  }
): CollectionRecord {
  const next = cloneJson(collection);

  if (input.name !== undefined) {
    next.name = input.name;
  }
  if (input.allowList !== undefined) {
    next.allowList = input.allowList;
  }
  if (input.rules !== undefined) {
    next.rules = cloneJson(input.rules);
  }
  if (input.filters !== undefined) {
    const rules = asRecord(next.rules) ? cloneJson(next.rules as Record<string, unknown>) : {};
    rules.filters = cloneJson(input.filters);
    next.rules = rules;
  }

  return next;
}

export function registerCollectionTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string }
) {
  const listCollectionsHandler = async (parsed: { workspaceId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const loaded = await loadWorkspaceRoot(gql, workspaceId);
    try {
      const collections = listCollections(getCollectionsArray(loaded.doc) ?? new Y.Array<any>());
      return text({
        workspaceId,
        totalCollections: collections.length,
        collections,
      });
    } finally {
      loaded.socket.disconnect();
    }
  };

  server.registerTool(
    "list_collections",
    {
      title: "List Collections",
      description: "List all collections in a workspace.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
      },
    },
    listCollectionsHandler as any
  );

  const getCollectionHandler = async (parsed: { workspaceId?: string; collectionId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const loaded = await loadWorkspaceRoot(gql, workspaceId);
    try {
      const match = findCollection(getCollectionsArray(loaded.doc) ?? new Y.Array<any>(), parsed.collectionId);
      if (!match) {
        throw new Error(`collectionId ${parsed.collectionId} is not present in workspace ${workspaceId}`);
      }
      return text({
        workspaceId,
        collection: match.collection,
      });
    } finally {
      loaded.socket.disconnect();
    }
  };

  server.registerTool(
    "get_collection",
    {
      title: "Get Collection",
      description: "Get details of a specific collection.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
      },
    },
    getCollectionHandler as any
  );

  const createCollectionHandler = async (parsed: {
    workspaceId?: string;
    collectionId?: string;
    name: string;
    allowList?: string[];
    rules?: Record<string, unknown>;
    filters?: unknown[];
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const loaded = await loadWorkspaceRoot(gql, workspaceId);
    try {
      const collections = ensureCollectionsArray(loaded.doc);
      const collectionId = parsed.collectionId || generateId();
      if (findCollection(collections, collectionId)) {
        throw new Error(`collectionId ${collectionId} already exists in workspace ${workspaceId}`);
      }

      const collection = applyCollectionChanges(
        {
          id: collectionId,
          name: parsed.name,
          allowList: [],
          rules: { filters: [] },
        },
        {
          allowList: parsed.allowList,
          rules: parsed.rules,
          filters: parsed.filters,
        }
      );

      // AFFiNE persists collection entries as plain JSON objects in the root Y.Array.
      // Writing Y.Map/Y.Array here can make UI parsing fail (undefined id/name + denied access).
      collections.push([cloneJson(collection)]);
      await saveWorkspaceRoot(loaded.socket, workspaceId, loaded.doc, loaded.prevStateVector);

      return text({
        workspaceId,
        created: true,
        collection: normalizeCollection(collection),
      });
    } finally {
      loaded.socket.disconnect();
    }
  };

  server.registerTool(
    "create_collection",
    {
      title: "Create Collection",
      description: "Create a collection in a workspace.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId.optional().describe("Optional custom collection ID."),
        name: z.string().min(1).describe("Collection name"),
        allowList: z.array(z.string()).optional().describe("Optional list of document IDs explicitly included."),
        rules: JsonObject.optional().describe("Optional AFFiNE collection rules object."),
        filters: JsonArray.optional().describe("Optional rule filters; overrides rules.filters when provided."),
      },
    },
    createCollectionHandler as any
  );

  const updateCollectionHandler = async (parsed: {
    workspaceId?: string;
    collectionId: string;
    name?: string;
    allowList?: string[];
    rules?: Record<string, unknown>;
    filters?: unknown[];
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const loaded = await loadWorkspaceRoot(gql, workspaceId);
    try {
      const collections = ensureCollectionsArray(loaded.doc);
      const match = findCollection(collections, parsed.collectionId);
      if (!match) {
        throw new Error(`collectionId ${parsed.collectionId} is not present in workspace ${workspaceId}`);
      }

      const next = applyCollectionChanges(match.collection, {
        name: parsed.name,
        allowList: parsed.allowList,
        rules: parsed.rules,
        filters: parsed.filters,
      });

      collections.delete(match.index, 1);
      // Preserve AFFiNE's expected JSON entry type for collection records.
      collections.insert(match.index, [cloneJson(next)]);
      await saveWorkspaceRoot(loaded.socket, workspaceId, loaded.doc, loaded.prevStateVector);

      return text({
        workspaceId,
        updated: true,
        collection: normalizeCollection(next),
      });
    } finally {
      loaded.socket.disconnect();
    }
  };

  server.registerTool(
    "update_collection",
    {
      title: "Update Collection",
      description: "Update a collection in a workspace.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
        name: z.string().min(1).optional().describe("Updated collection name"),
        allowList: z.array(z.string()).optional().describe("Updated explicit document allow-list."),
        rules: JsonObject.optional().describe("Updated AFFiNE collection rules object."),
        filters: JsonArray.optional().describe("Updated rule filters; overrides rules.filters when provided."),
      },
    },
    updateCollectionHandler as any
  );

  const deleteCollectionHandler = async (parsed: { workspaceId?: string; collectionId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const loaded = await loadWorkspaceRoot(gql, workspaceId);
    try {
      const collections = ensureCollectionsArray(loaded.doc);
      const match = findCollection(collections, parsed.collectionId);
      if (!match) {
        return text({
          workspaceId,
          collectionId: parsed.collectionId,
          deleted: false,
        });
      }

      collections.delete(match.index, 1);
      await saveWorkspaceRoot(loaded.socket, workspaceId, loaded.doc, loaded.prevStateVector);

      return text({
        workspaceId,
        collectionId: parsed.collectionId,
        deleted: true,
      });
    } finally {
      loaded.socket.disconnect();
    }
  };

  server.registerTool(
    "delete_collection",
    {
      title: "Delete Collection",
      description: "Delete a collection from a workspace.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        collectionId: CollectionId,
      },
    },
    deleteCollectionHandler as any
  );
}
