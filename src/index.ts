#!/usr/bin/env node

// 1. Defensive check for native dependencies (MUST be first)
try {
    require.resolve('@lancedb/lancedb');
    const ortPackagePath = require.resolve('onnxruntime-node/package.json');
    const ortVersion = require(ortPackagePath).version as string | undefined;
    const isCompatibleOrt = typeof ortVersion === 'string' && /^1\.14(\.|$)/.test(ortVersion);
    if (!isCompatibleOrt) {
      console.error('\n[Gemini Obsidian] Error: Incompatible onnxruntime-node version detected.');
      console.error(`Installed: ${ortVersion ?? 'unknown'}, required: 1.14.x`);
      console.error('This project bundles @xenova/transformers 2.17.x, which requires onnxruntime-node 1.14.x.');
      console.error('Please run:');
      console.error(`  cd ${require('path').join(__dirname, '..')} && npm install onnxruntime-node@1.14.0 --save-exact\n`);
      process.exit(1);
    }
} catch (e) {
    console.error('\n[Gemini Obsidian] Error: Required native dependencies are missing.');
    console.error('This usually happens if "npm install" was not run or failed.');
    console.error('Please run the following command in the extension directory:');
    console.error(`  cd ${require('path').join(__dirname, '..')} && npm install\n`);
    process.exit(1);
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import matter from 'gray-matter';
import { VaultIndexer } from './rag/store.js';

let VAULT_PATH: string | null = process.env.OBSIDIAN_VAULT_PATH || null;
const indexer = new VaultIndexer();
const CONFIG_PATH = path.join(os.homedir(), '.gemini-obsidian.config.json');

async function saveConfig(vaultPath: string) {
    try {
        await fs.writeFile(CONFIG_PATH, JSON.stringify({ vault_path: vaultPath }), 'utf-8');
    } catch (e) { console.error("Failed to save config", e); }
}

async function loadConfig(): Promise<string | null> {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        return JSON.parse(data).vault_path;
    } catch { return null; }
}

/**
 * Helper to validate vault path
 */
function getVaultPath(providedPath?: string): string {
  const p = providedPath || VAULT_PATH;
  if (!p) {
    throw new McpError(ErrorCode.InvalidParams, "Vault path is not set. Use obsidian_set_vault or provide 'vault_path' argument.");
  }
  return p;
}

async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
        process.stdin.on('error', (err) => {
            reject(err);
        });
        // Handle cases where stdin might be empty or already closed
        setTimeout(() => {
            if (data === '') {
                // If no data after 1s, resolve with empty to avoid hang
                resolve('');
            }
        }, 1000);
    });
}

(async () => {
  // Load config if environment variable is not set
  if (!VAULT_PATH) {
      VAULT_PATH = await loadConfig();
  }

  // Handle CLI args for one-shot mode
  const args = process.argv.slice(2);
  
  // If arguments start with a tool name (simple heuristic)
  const knownTools = ['obsidian_list_notes', 'obsidian_read_note', 'obsidian_search_notes', 'obsidian_rag_index', 'obsidian_rag_query', 'obsidian_set_vault', 'obsidian_create_note', 'obsidian_append_note', 'obsidian_get_daily_note', 'obsidian_get_backlinks', 'obsidian_get_links', 'obsidian_move_note', 'obsidian_update_frontmatter', 'obsidian_append_daily_log'];
  
  if (args.length > 0 && knownTools.includes(args[0])) {
    const toolName = args[0];
    const toolArgs = args.slice(1);
    
    const parsedArgs: any = {};
    for (let i = 0; i < toolArgs.length; i++) {
        if (toolArgs[i] && toolArgs[i].startsWith('--')) {
            const key = toolArgs[i].substring(2);
            if (i + 1 < toolArgs.length && !toolArgs[i+1].startsWith('--')) {
                parsedArgs[key] = toolArgs[i+1];
                i++;
            } else {
                parsedArgs[key] = true;
            }
        }
    }

    try {
        let result;
        if (toolName === 'obsidian_list_notes') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const sub = parsedArgs.subfolder ? String(parsedArgs.subfolder) : '**';
            const pattern = path.join(sub, '*.md');
            const files = await glob(pattern, { cwd: vp, follow: true });
            result = JSON.stringify(files.slice(0, 100), null, 2) + (files.length > 100 ? `\n...and ${files.length - 100} more.` : '');
        } else if (toolName === 'obsidian_read_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            result = await fs.readFile(filePath, 'utf-8');
        } else if (toolName === 'obsidian_create_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const content = String(parsedArgs.content || '');
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            result = `Created note: ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_append_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const content = String(parsedArgs.content || '');
            await fs.appendFile(filePath, '\n' + content, 'utf-8');
            result = `Appended to note: ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_get_daily_note') {
             const vp = getVaultPath(parsedArgs.vault_path);
             const dateStr = new Date().toISOString().split('T')[0];
             const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
             const fileName = `${dateStr}.md`;
             const filePath = path.join(vp, dailyFolder, fileName);
             try {
                 result = await fs.readFile(filePath, 'utf-8');
             } catch (e) {
                 await fs.mkdir(path.dirname(filePath), { recursive: true });
                 const content = `# ${dateStr}\n\n`;
                 await fs.writeFile(filePath, content, 'utf-8');
                 result = content;
             }
        } else if (toolName === 'obsidian_search_notes') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const query = String(parsedArgs.query).toLowerCase();
            const files = await glob('**/*.md', { cwd: vp, follow: true });
            const matches: string[] = [];
            for (const f of files) {
                if (f.toLowerCase().includes(query)) {
                     matches.push(f + " (Filename match)"); continue;
                }
                try {
                     const c = await fs.readFile(path.join(vp, f), 'utf-8');
                     if (c.toLowerCase().includes(query)) matches.push(f);
                } catch(e) {}
                if (matches.length >= 20) break;
            }
            result = matches.join('\n');
        } else if (toolName === 'obsidian_rag_index') {
            let vp, fp;
            if (parsedArgs.hook) {
                const inputStr = await readStdin();
                if (!inputStr) {
                    process.exit(1);
                }
                const input = JSON.parse(inputStr);
                vp = getVaultPath(input.tool_input?.vault_path || VAULT_PATH);
                fp = input.tool_input?.file_path;
            } else {
                vp = getVaultPath(parsedArgs.vault_path);
                fp = parsedArgs.file_path ? String(parsedArgs.file_path) : null;
            }
            const force = parsedArgs.force_reindex === true || parsedArgs.force === true;
            let res;
            if (fp) {
                res = await indexer.indexFile(vp, String(fp));
            } else {
                res = await indexer.indexVault(vp, force);
            }
            result = JSON.stringify(res);
        } else if (toolName === 'obsidian_rag_query') {
            const query = String(parsedArgs.query);
            const limit = Number(parsedArgs.limit) || 5;
            const res = await indexer.search(query, limit);
            result = res.map((r: any) => `File: ${r.path}\nContent: ${r.text}`).join('\n---\n');
        } else if (toolName === 'obsidian_get_backlinks') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const target = String(parsedArgs.file_name).replace(/\.md$/i, ''); 
            const linkRegex = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\]\\|#])`, 'i');
            
            const files = await glob('**/*.md', { cwd: vp, follow: true });
            
            const backlinks: string[] = [];
            const batchSize = 50;
            
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                await Promise.all(batch.map(async (f) => {
                    try {
                        const content = await fs.readFile(path.join(vp, f), 'utf-8');
                        if (linkRegex.test(content)) {
                            backlinks.push(f);
                        }
                    } catch (e) { }
                }));
            }
            if (backlinks.length === 0) {
                 result = `No backlinks found for "[[${target}]]".`;
            } else {
                 result = `Found ${backlinks.length} backlinks for "[[${target}]]":\n` + backlinks.map(f => `- ${f}`).join('\n');
            }
        } else if (toolName === 'obsidian_get_links') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const content = await fs.readFile(filePath, 'utf-8');
            const regex = /\[\[(.*?)(?:\|.*?)?\]\]/g;
            const links: string[] = [];
            let match;
            while ((match = regex.exec(content)) !== null) {
                links.push(match[1]);
            }
            result = JSON.stringify([...new Set(links)], null, 2);
        } else if (toolName === 'obsidian_move_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const source = path.join(vp, String(parsedArgs.source_path));
            const dest = path.join(vp, String(parsedArgs.dest_path));
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.rename(source, dest);
            result = `Moved ${parsedArgs.source_path} to ${parsedArgs.dest_path}`;
        } else if (toolName === 'obsidian_update_frontmatter') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const key = String(parsedArgs.key);
            let value: any = parsedArgs.value;
            try { value = JSON.parse(String(parsedArgs.value)); } catch (e) {}
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const parsed = matter(fileContent);
            parsed.data[key] = value;
            const updatedContent = matter.stringify(parsed.content, parsed.data);
            await fs.writeFile(filePath, updatedContent, 'utf-8');
            result = `Updated frontmatter "${key}" in ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_append_daily_log') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const heading = String(parsedArgs.heading);
            const content = String(parsedArgs.content);
            const dateStr = new Date().toISOString().split('T')[0];
            const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
            const fileName = `${dateStr}.md`;
            const filePath = path.join(vp, dailyFolder, fileName);
            let fileContent = '';
            try { fileContent = await fs.readFile(filePath, 'utf-8'); } catch (e) {
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                fileContent = `# ${dateStr}\n\n`;
            }
            const headingRegex = new RegExp(`^#+\\s+${heading}\\s*$`, 'm');
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const entry = `\n- [${timestamp}] ${content}`;
            if (headingRegex.test(fileContent)) {
                const match = headingRegex.exec(fileContent);
                if (match) {
                    const headingIndex = match.index + match[0].length;
                    fileContent = fileContent.slice(0, headingIndex) + entry + fileContent.slice(headingIndex);
                }
            } else {
                fileContent += `\n\n## ${heading}${entry}`;
            }
            await fs.writeFile(filePath, fileContent, 'utf-8');
            result = `Appended to daily note under "${heading}"`;
        } else {
            console.error(`Unknown tool: ${toolName}`);
            process.exit(1);
        }
        console.log(result);
        process.exit(0);
    } catch (error: any) {
        console.error(error.message);
        process.exit(1);
    }
  }

  // MCP Server Mode
  const server = new Server(
    {
      name: 'gemini-obsidian',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'obsidian_set_vault',
          description: 'Set the default Obsidian vault path for this session.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path to the Obsidian vault' },
            },
            required: ['path'],
          },
        },
        {
          name: 'obsidian_list_notes',
          description: 'List markdown files in the vault or a subdirectory.',
          inputSchema: {
            type: 'object',
            properties: {
              subfolder: { type: 'string', description: 'Optional subfolder to list' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
          },
        },
        {
          name: 'obsidian_read_note',
          description: 'Read the content of a specific note (Markdown).',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Relative path to the note' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['file_path'],
          },
        },
        {
          name: 'obsidian_create_note',
          description: 'Create a new note with the given content.',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Relative path for the new note (e.g. "Ideas/MyIdea.md")' },
              content: { type: 'string', description: 'Initial content of the note' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['file_path', 'content'],
          },
        },
        {
          name: 'obsidian_append_note',
          description: 'Append text to the end of an existing note.',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Relative path to the note' },
              content: { type: 'string', description: 'Text to append' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['file_path', 'content'],
          },
        },
        {
          name: 'obsidian_get_daily_note',
          description: 'Get (or create) today\'s daily note.',
          inputSchema: {
            type: 'object',
            properties: {
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
          },
        },
        {
          name: 'obsidian_search_notes',
          description: 'Search for notes containing specific text (simple text match).',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Text to search for' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['query'],
          },
        },
        {
          name: 'obsidian_rag_index',
          description: 'Index the vault for semantic search (RAG). If file_path is provided, only that file is re-indexed. Incremental by default — only re-embeds changed files. Use force_reindex to rebuild from scratch.',
          inputSchema: {
            type: 'object',
            properties: {
              vault_path: { type: 'string', description: 'Optional vault path override' },
              file_path: { type: 'string', description: 'Relative path to a specific note to re-index' },
              force_reindex: { type: 'boolean', description: 'Force full re-index, ignoring cached file hashes (default: false)' },
            },
          },
        },
        {
          name: 'obsidian_rag_query',
          description: 'Perform a semantic search on the indexed vault.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Question or query to ask your notes' },
              limit: { type: 'number', description: 'Number of chunks to retrieve (default 5)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'obsidian_get_backlinks',
          description: 'Find all notes that link to a specific note.',
          inputSchema: {
            type: 'object',
            properties: {
              file_name: { type: 'string', description: 'Name of the note to find backlinks for (without extension)' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['file_name'],
          },
        },
        {
          name: 'obsidian_get_links',
          description: 'Get all outgoing links from a specific note.',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Relative path to the note' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['file_path'],
          },
        },
        {
          name: 'obsidian_move_note',
          description: 'Move or rename a note.',
          inputSchema: {
            type: 'object',
            properties: {
              source_path: { type: 'string', description: 'Current relative path of the note' },
              dest_path: { type: 'string', description: 'New relative path for the note (e.g. "Archive/OldNote.md")' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['source_path', 'dest_path'],
          },
        },
        {
          name: 'obsidian_update_frontmatter',
          description: 'Update YAML frontmatter of a note safely.',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Relative path to the note' },
              key: { type: 'string', description: 'Frontmatter key to update (e.g., "status", "tags")' },
              value: { type: 'string', description: 'New value for the key (JSON stringified if array/object)' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['file_path', 'key', 'value'],
          },
        },
        {
          name: 'obsidian_append_daily_log',
          description: 'Append text to a specific heading in today\'s daily note.',
          inputSchema: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'Heading to append under (e.g., "Work Log", "Ideas")' },
              content: { type: 'string', description: 'Text to append' },
              vault_path: { type: 'string', description: 'Optional vault path override' },
            },
            required: ['heading', 'content'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'obsidian_set_vault') {
          VAULT_PATH = String(args?.path);
          await saveConfig(VAULT_PATH);
          return { content: [{ type: 'text', text: `Vault path set to: ${VAULT_PATH}` }] };
      }
      if (name === 'obsidian_list_notes') {
          const vp = getVaultPath(args?.vault_path as string);
          const sub = args?.subfolder ? String(args.subfolder) : '**';
          const pattern = path.join(sub, '*.md');
          const files = await glob(pattern, { cwd: vp, follow: true });
          return { content: [{ type: 'text', text: JSON.stringify(files.slice(0, 100), null, 2) + (files.length > 100 ? `\n...and ${files.length - 100} more.` : '') }] };
      }
      if (name === 'obsidian_read_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = await fs.readFile(filePath, 'utf-8');
          return { content: [{ type: 'text', text: content }] };
      }
      if (name === 'obsidian_create_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = String(args?.content || '');
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, 'utf-8');
          return { content: [{ type: 'text', text: `Created note: ${args?.file_path}` }] };
      }
      if (name === 'obsidian_append_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = String(args?.content || '');
          await fs.appendFile(filePath, '\n' + content, 'utf-8');
          return { content: [{ type: 'text', text: `Appended to note: ${args?.file_path}` }] };
      }
      if (name === 'obsidian_get_daily_note') {
           const vp = getVaultPath(args?.vault_path as string);
           const dateStr = new Date().toISOString().split('T')[0];
           const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
           const fileName = `${dateStr}.md`;
           const filePath = path.join(vp, dailyFolder, fileName);
           let content = '';
           try {
               content = await fs.readFile(filePath, 'utf-8');
           } catch (e) {
               await fs.mkdir(path.dirname(filePath), { recursive: true });
               content = `# ${dateStr}\n\n`;
               await fs.writeFile(filePath, content, 'utf-8');
           }
           return { content: [{ type: 'text', text: content }] };
      }
      if (name === 'obsidian_search_notes') {
          const vp = getVaultPath(args?.vault_path as string);
          const query = String(args?.query).toLowerCase();
          const files = await glob('**/*.md', { cwd: vp, follow: true });
          const matches: string[] = [];
          for (const f of files) {
              if (f.toLowerCase().includes(query)) {
                  matches.push(f + " (Filename match)"); continue;
              }
              try {
                  const content = await fs.readFile(path.join(vp, f), 'utf-8');
                  if (content.toLowerCase().includes(query)) matches.push(f);
              } catch (e) { } 
              if (matches.length >= 20) break;
          }
          return { content: [{ type: 'text', text: matches.join('\n') }] };
      }
      if (name === 'obsidian_rag_index') {
          const vp = getVaultPath(args?.vault_path as string);
          const fp = args?.file_path ? String(args.file_path) : null;
          const force = args?.force_reindex === true;
          let result;
          if (fp) {
              result = await indexer.indexFile(vp, fp);
          } else {
              result = await indexer.indexVault(vp, force);
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'obsidian_rag_query') {
          const query = String(args?.query);
          const limit = Number(args?.limit) || 5;
          const results = await indexer.search(query, limit);
          const formatted = results.map((r: any) => 
              `---\nFile: ${r.path}\nRelevance: ${r._distance}\nContent: ${r.text}\n---`
          ).join('\n');
          return { content: [{ type: 'text', text: formatted }] };
      }
      if (name === 'obsidian_get_backlinks') {
          const vp = getVaultPath(args?.vault_path as string);
          const target = String(args?.file_name).replace(/\.md$/i, ''); 
          const linkRegex = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\]\\|#])`, 'i');
          
          const files = await glob('**/*.md', { cwd: vp, follow: true });
          
          // Parallel processing with simple concurrency control (batches of 50)
          const backlinks: string[] = [];
          const batchSize = 50;
          
          for (let i = 0; i < files.length; i += batchSize) {
              const batch = files.slice(i, i + batchSize);
              await Promise.all(batch.map(async (f) => {
                  try {
                      const content = await fs.readFile(path.join(vp, f), 'utf-8');
                      if (linkRegex.test(content)) {
                          backlinks.push(f);
                      }
                  } catch (e) { }
              }));
          }
          
          if (backlinks.length === 0) {
               return { content: [{ type: 'text', text: `No backlinks found for "[[${target}]]".` }] };
          }
          return { content: [{ type: 'text', text: `Found ${backlinks.length} backlinks for "[[${target}]]":\n` + backlinks.map(f => `- ${f}`).join('\n') }] };
      }
      if (name === 'obsidian_get_links') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = await fs.readFile(filePath, 'utf-8');
          
          const regex = /\[\[(.*?)(?:\|.*?)?\]\]/g;
          const links: string[] = [];
          let match;
          while ((match = regex.exec(content)) !== null) {
              links.push(match[1]);
          }
          
          return { content: [{ type: 'text', text: JSON.stringify([...new Set(links)], null, 2) }] };
      }
      if (name === 'obsidian_move_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const source = path.join(vp, String(args?.source_path));
          const dest = path.join(vp, String(args?.dest_path));
          
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(source, dest);
          return { content: [{ type: 'text', text: `Moved ${args?.source_path} to ${args?.dest_path}` }] };
      }
      if (name === 'obsidian_update_frontmatter') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const key = String(args?.key);
          let value: any = args?.value;
          
          try {
              value = JSON.parse(String(args?.value));
          } catch (e) {
              // use as string if not valid JSON
          }
          
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const parsed = matter(fileContent);
          parsed.data[key] = value;
          
          const updatedContent = matter.stringify(parsed.content, parsed.data);
          await fs.writeFile(filePath, updatedContent, 'utf-8');
          
          return { content: [{ type: 'text', text: `Updated frontmatter "${key}" in ${args?.file_path}` }] };
      }
      if (name === 'obsidian_append_daily_log') {
          const vp = getVaultPath(args?.vault_path as string);
          const heading = String(args?.heading);
          const content = String(args?.content);
          
          const dateStr = new Date().toISOString().split('T')[0];
          const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
          const fileName = `${dateStr}.md`;
          const filePath = path.join(vp, dailyFolder, fileName);
          
          let fileContent = '';
          try {
              fileContent = await fs.readFile(filePath, 'utf-8');
          } catch (e) {
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              fileContent = `# ${dateStr}\n\n`;
          }

          const headingRegex = new RegExp(`^#+\\s+${heading}\\s*$`, 'm');
          const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const entry = `\n- [${timestamp}] ${content}`;

          if (headingRegex.test(fileContent)) {
              // Append after the heading
              // We find the index of the heading, then look for the next heading or end of file
              const match = headingRegex.exec(fileContent);
              if (match) {
                  const headingIndex = match.index + match[0].length;
                  // Insert immediately after the heading
                  fileContent = fileContent.slice(0, headingIndex) + entry + fileContent.slice(headingIndex);
              }
          } else {
              // Append heading and content to the end
              fileContent += `\n\n## ${heading}${entry}`;
          }
          
          await fs.writeFile(filePath, fileContent, 'utf-8');
          return { content: [{ type: 'text', text: `Appended to daily note under "${heading}"` }] };
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
