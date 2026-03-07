#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP_SERVER_PATH = './dist/index.js';
const BASE_URL = process.env.AFFINE_BASE_URL || null;
const EMAIL = process.env.AFFINE_EMAIL || null;
const PASSWORD = process.env.AFFINE_PASSWORD || null;
const LOGIN_MODE = process.env.AFFINE_LOGIN_AT_START || 'sync';
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || '60000');
const MANIFEST_PATH = path.join(process.cwd(), 'tool-manifest.json');
const EXPECTED_TOOLS = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).tools;

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toErrorMessage(parsed) {
  if (!parsed) return null;
  if (typeof parsed === 'string') {
    if (/^GraphQL error:/i.test(parsed) || /^Error:/i.test(parsed)) return parsed;
    return null;
  }
  if (typeof parsed === 'object' && parsed.error) return String(parsed.error);
  return null;
}

function isBlockedByEnvironment(_toolName, errorMessage) {
  if (!errorMessage) return false;
  return false;
}

class ComprehensiveRunner {
  constructor() {
    const serverEnv = { ...process.env };
    if (BASE_URL) serverEnv.AFFINE_BASE_URL = BASE_URL;
    if (EMAIL) serverEnv.AFFINE_EMAIL = EMAIL;
    if (PASSWORD) serverEnv.AFFINE_PASSWORD = PASSWORD;
    if (LOGIN_MODE) serverEnv.AFFINE_LOGIN_AT_START = LOGIN_MODE;

    this.client = new Client({ name: 'affine-mcp-comprehensive-test', version: '3.0.0' });
    this.transport = new StdioClientTransport({
      command: 'node',
      args: [MCP_SERVER_PATH],
      cwd: process.cwd(),
      env: serverEnv,
      stderr: 'pipe',
    });

    this.results = [];
    this.called = new Set();
    this.serverTools = [];

    this.workspaceId = null;
    this.workspaceName = null;
    this.docId = null;
    this.markdownDocId = null;
    this.collectionId = null;
    this.commentId = null;
    this.tokenId = null;
    this.blobKey = null;
  }

  async start() {
    this.transport.stderr?.on('data', chunk => {
      process.stderr.write(`[server] ${chunk}`);
    });
    await this.client.connect(this.transport);
    const tools = await this.client.listTools();
    this.serverTools = tools.tools.map(t => t.name).sort();
  }

  async stop() {
    await this.transport.close();
  }

  async callTool(name, args = {}, after) {
    this.called.add(name);

    const record = {
      name,
      args,
      ok: false,
      blocked: false,
      durationMs: 0,
      error: null,
      result: null,
    };

    const start = Date.now();

    if (!this.serverTools.includes(name)) {
      record.error = 'Tool is not registered on server';
      this.results.push(record);
      return record;
    }

    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: TOOL_TIMEOUT_MS }
      );
      const parsed = parseContent(result);
      const semanticError = toErrorMessage(parsed);
      record.result = parsed;
      record.durationMs = Date.now() - start;

      if (semanticError) {
        if (isBlockedByEnvironment(name, semanticError)) {
          record.ok = true;
          record.blocked = true;
          record.error = semanticError;
        } else {
          record.ok = false;
          record.error = semanticError;
        }
      } else {
        record.ok = true;
      }

      if (after) {
        try {
          after(parsed);
        } catch (error) {
          record.ok = false;
          record.error = `Post-processing failed: ${error?.message || String(error)}`;
        }
      }
    } catch (error) {
      record.durationMs = Date.now() - start;
      record.ok = false;
      record.error = error?.message || String(error);
    }

    this.results.push(record);
    return record;
  }

  async run() {
    await this.start();

    const missingFromServer = EXPECTED_TOOLS.filter(name => !this.serverTools.includes(name));
    const extraOnServer = this.serverTools.filter(name => !EXPECTED_TOOLS.includes(name));
    if (missingFromServer.length || extraOnServer.length) {
      throw new Error(
        `Tool list mismatch. missing=${JSON.stringify(missingFromServer)} extra=${JSON.stringify(extraOnServer)}`
      );
    }

    await this.callTool('current_user');
    if (EMAIL && PASSWORD) {
      await this.callTool('sign_in', { email: EMAIL, password: PASSWORD });
    }

    const workspaceName = `mcp-main-${Date.now()}`;
    await this.callTool('list_workspaces');
    await this.callTool('create_workspace', { name: workspaceName }, parsed => {
      this.workspaceId = parsed?.id || null;
      this.workspaceName = parsed?.name || workspaceName;
    });

    const workspaceId = this.workspaceId;
    if (!workspaceId) {
      throw new Error('create_workspace did not return workspace id');
    }

    await this.callTool('get_workspace', { id: workspaceId }, parsed => {
      if (parsed?.id !== workspaceId) {
        throw new Error('get_workspace did not return the requested workspace');
      }
      if (parsed?.name !== this.workspaceName) {
        throw new Error(`get_workspace did not include workspace name "${this.workspaceName}"`);
      }
    });
    await this.callTool('list_workspaces', {}, parsed => {
      const workspaces = Array.isArray(parsed) ? parsed : [];
      const createdWorkspace = workspaces.find(entry => entry?.id === workspaceId);
      if (!createdWorkspace) {
        throw new Error('list_workspaces did not include the created workspace');
      }
      if (createdWorkspace?.name !== this.workspaceName) {
        throw new Error(`list_workspaces did not include workspace name "${this.workspaceName}"`);
      }
    });
    await this.callTool('update_workspace', { id: workspaceId, public: false, enableAi: true });

    await this.callTool('list_docs', { workspaceId, first: 20 });
    await this.callTool('create_doc', { workspaceId, title: 'Main Doc', content: 'main content' }, parsed => {
      this.docId = parsed?.docId || null;
    });
    await this.callTool(
      'create_doc_from_markdown',
      {
        workspaceId,
        markdown: '# Markdown Doc\\n\\n- [x] Imported todo\\n\\n```ts\\nconsole.log(\"hello\")\\n```',
      },
      parsed => {
        this.markdownDocId = parsed?.docId || null;
      }
    );

    const docId = this.docId;
    if (!docId) {
      throw new Error('create_doc did not return docId');
    }
    const markdownDocId = this.markdownDocId;
    const tagName = `mcp-tag-${Date.now()}`;
    const collectionName = `mcp-collection-${Date.now()}`;
    const updatedCollectionName = `${collectionName}-updated`;

    await this.callTool('list_collections', { workspaceId });
    await this.callTool('create_collection', {
      workspaceId,
      name: collectionName,
      allowList: [docId],
      filters: [],
    }, parsed => {
      this.collectionId = parsed?.collection?.id || null;
      if (parsed?.collection?.name !== collectionName) {
        throw new Error('create_collection did not return the created name');
      }
    });
    if (!this.collectionId) {
      throw new Error('create_collection did not return collection id');
    }
    await this.callTool('get_collection', { workspaceId, collectionId: this.collectionId }, parsed => {
      if (parsed?.collection?.id !== this.collectionId) {
        throw new Error('get_collection did not return the requested collection');
      }
      if (parsed?.collection?.name !== collectionName) {
        throw new Error('get_collection did not return the original collection name');
      }
      const allowList = Array.isArray(parsed?.collection?.allowList) ? parsed.collection.allowList : [];
      if (!allowList.includes(docId)) {
        throw new Error('get_collection did not preserve allowList');
      }
    });
    await this.callTool('list_collections', { workspaceId }, parsed => {
      const collections = Array.isArray(parsed?.collections) ? parsed.collections : [];
      if (!collections.some(entry => entry?.id === this.collectionId && entry?.name === collectionName)) {
        throw new Error('list_collections did not include created collection');
      }
    });
    await this.callTool('update_collection', {
      workspaceId,
      collectionId: this.collectionId,
      name: updatedCollectionName,
      allowList: [docId, markdownDocId].filter(Boolean),
      filters: [{ key: 'title', op: 'contains', value: 'Main' }],
    }, parsed => {
      if (parsed?.collection?.name !== updatedCollectionName) {
        throw new Error('update_collection did not update the collection name');
      }
    });
    await this.callTool('get_collection', { workspaceId, collectionId: this.collectionId }, parsed => {
      if (parsed?.collection?.name !== updatedCollectionName) {
        throw new Error('get_collection did not return updated collection name');
      }
      const allowList = Array.isArray(parsed?.collection?.allowList) ? parsed.collection.allowList : [];
      if (!allowList.includes(docId)) {
        throw new Error('updated collection allowList lost the main doc');
      }
      if (markdownDocId && !allowList.includes(markdownDocId)) {
        throw new Error('updated collection allowList did not include markdown doc');
      }
      const filters = Array.isArray(parsed?.collection?.filters) ? parsed.collection.filters : [];
      if (filters.length !== 1) {
        throw new Error('updated collection did not preserve filters');
      }
    });
    await this.callTool('delete_collection', { workspaceId, collectionId: this.collectionId }, parsed => {
      if (!parsed?.deleted) {
        throw new Error('delete_collection did not report deletion');
      }
    });
    await this.callTool('list_collections', { workspaceId }, parsed => {
      const collections = Array.isArray(parsed?.collections) ? parsed.collections : [];
      if (collections.some(entry => entry?.id === this.collectionId)) {
        throw new Error('list_collections still included deleted collection');
      }
    });

    await this.callTool('create_tag', { workspaceId, tag: tagName });
    await this.callTool('add_tag_to_doc', { workspaceId, docId, tag: tagName });
    await this.callTool('list_tags', { workspaceId }, parsed => {
      const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
      if (!tags.some(entry => entry?.name === tagName)) {
        throw new Error('list_tags did not include created tag');
      }
    });
    await this.callTool('list_docs_by_tag', { workspaceId, tag: tagName }, parsed => {
      const docs = Array.isArray(parsed?.docs) ? parsed.docs : [];
      if (!docs.some(entry => entry?.id === docId)) {
        throw new Error('list_docs_by_tag did not include tagged doc');
      }
    });
    await this.callTool('list_docs', { workspaceId, first: 20 }, parsed => {
      const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];
      const mainDoc = edges.map(edge => edge?.node).find(node => node?.id === docId);
      if (!mainDoc) {
        throw new Error('list_docs did not include created doc');
      }
      if (!Array.isArray(mainDoc.tags) || !mainDoc.tags.includes(tagName)) {
        throw new Error('list_docs did not include tags for created doc');
      }
    });

    await this.callTool('get_doc', { workspaceId, docId });
    await this.callTool('publish_doc', { workspaceId, docId });
    await this.callTool('revoke_doc', { workspaceId, docId });
    await this.callTool('append_paragraph', { workspaceId, docId, text: 'appended from test' });
    await this.callTool('append_block', { workspaceId, docId, type: 'heading2', text: 'Heading from append_block' });
    await this.callTool('append_block', { workspaceId, docId, type: 'quote', text: 'Quote from append_block' });
    await this.callTool('append_block', { workspaceId, docId, type: 'bulleted_list', text: 'Bulleted item from append_block' });
    await this.callTool('append_block', { workspaceId, docId, type: 'numbered_list', text: 'Numbered item from append_block' });
    await this.callTool('append_block', { workspaceId, docId, type: 'todo', text: 'Todo item from append_block', checked: true });
    await this.callTool('append_block', { workspaceId, docId, type: 'code', text: 'console.log(\"append_block\");', language: 'javascript' });
    await this.callTool('append_block', { workspaceId, docId, type: 'divider' });
    let databaseBlockId = null;
    await this.callTool('append_block', { workspaceId, docId, type: 'database' }, parsed => {
      databaseBlockId = parsed?.blockId || null;
    });
    if (!databaseBlockId) {
      throw new Error('append_block(database) did not return blockId');
    }
    const databaseColumnName = `Status-${Date.now()}`;
    await this.callTool('add_database_column', {
      workspaceId,
      docId,
      databaseBlockId,
      name: databaseColumnName,
      type: 'select',
      options: ['Todo', 'Done'],
    });
    await this.callTool('add_database_row', {
      workspaceId,
      docId,
      databaseBlockId,
      cells: {
        [databaseColumnName]: 'Todo',
      },
    });
    await this.callTool('append_markdown', {
      workspaceId,
      docId,
      markdown: '## Appended Heading\\n\\n- appended list item\\n\\n[link](https://example.com)',
    });
    await this.callTool('export_doc_markdown', {
      workspaceId,
      docId,
      includeFrontmatter: true,
    });
    await this.callTool('replace_doc_with_markdown', {
      workspaceId,
      docId,
      markdown: '# Replaced Content\\n\\nParagraph after replace.',
    });
    await this.callTool('read_doc', { workspaceId, docId }, parsed => {
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('read_doc did not return JSON payload');
      }
      if (!Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
        throw new Error('read_doc returned no blocks');
      }
      if (!Array.isArray(parsed.tags) || !parsed.tags.includes(tagName)) {
        throw new Error('read_doc tags did not include assigned tag');
      }
    });
    await this.callTool('remove_tag_from_doc', { workspaceId, docId, tag: tagName });

    await this.callTool('list_comments', { workspaceId, docId, first: 20 });
    await this.callTool('create_comment', {
      workspaceId,
      docId,
      docTitle: 'Main Doc',
      docMode: 'page',
      content: { text: 'comment-main' },
    }, parsed => {
      this.commentId = parsed?.id || null;
    });

    await this.callTool('update_comment', { id: this.commentId || 'missing-comment-id', content: { text: 'updated-main' } });
    await this.callTool('resolve_comment', { id: this.commentId || 'missing-comment-id', resolved: true });
    await this.callTool('delete_comment', { id: this.commentId || 'missing-comment-id' });

    await this.callTool('list_histories', { workspaceId, guid: docId, take: 20 });

    await this.callTool('list_access_tokens');
    await this.callTool('generate_access_token', { name: `token-main-${Date.now()}` }, parsed => {
      this.tokenId = parsed?.id || null;
    });
    await this.callTool('revoke_access_token', { id: this.tokenId || 'missing-token-id' });

    await this.callTool('list_notifications', { first: 20 });
    await this.callTool('read_all_notifications');

    await this.callTool('upload_blob', {
      workspaceId,
      content: 'Blob data from test',
      filename: 'test.txt',
      contentType: 'text/plain',
    }, parsed => {
      this.blobKey = parsed?.key || parsed?.id || null;
    });
    await this.callTool('delete_blob', {
      workspaceId,
      key: this.blobKey || 'missing-blob-key',
      permanently: true,
    });
    await this.callTool('cleanup_blobs', { workspaceId });

    await this.callTool('update_profile', { name: 'Dev User' });
    await this.callTool('update_settings', { settings: { receiveCommentEmail: true } });

    await this.callTool('delete_doc', { workspaceId, docId });
    await this.callTool('delete_workspace', { id: workspaceId });

    const skippedTools = new Set();
    if (!EMAIL || !PASSWORD) {
      skippedTools.add('sign_in');
    }

    for (const name of skippedTools) {
      if (this.called.has(name) || !this.serverTools.includes(name)) {
        continue;
      }
      this.results.push({
        name,
        args: {},
        ok: true,
        blocked: true,
        durationMs: 0,
        error: 'Tool skipped because AFFINE_EMAIL/AFFINE_PASSWORD are not configured for this test run',
        result: null,
      });
    }

    const uncalledTools = this.serverTools.filter(name => !this.called.has(name) && !skippedTools.has(name));
    for (const name of uncalledTools) {
      this.results.push({
        name,
        args: {},
        ok: false,
        blocked: false,
        durationMs: 0,
        error: 'Tool was never called by the comprehensive test',
        result: null,
      });
    }
  }

  summary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.ok).length;
    const blocked = this.results.filter(r => r.blocked).length;
    const failed = this.results.filter(r => !r.ok).length;

    return {
      generatedAt: new Date().toISOString(),
      server: {
        baseUrl: BASE_URL || '(from config/default)',
        email: EMAIL || '(from config/token auth)',
      },
      tools: {
        listed: this.serverTools.length,
        called: this.called.size,
      },
      totals: { total, passed, failed, blocked },
      results: this.results,
    };
  }
}

async function main() {
  console.log('Starting comprehensive AFFiNE MCP server test...');
  const runner = new ComprehensiveRunner();

  try {
    await runner.run();
  } finally {
    await runner.stop();
  }

  const summary = runner.summary();
  const fileName = `comprehensive-test-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(fileName, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({
    listedTools: summary.tools.listed,
    calledTools: summary.tools.called,
    totalChecks: summary.totals.total,
    passed: summary.totals.passed,
    blocked: summary.totals.blocked,
    failed: summary.totals.failed,
    resultsFile: fileName,
  }, null, 2));

  if (summary.totals.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Comprehensive test failed:', error);
  process.exit(1);
});
