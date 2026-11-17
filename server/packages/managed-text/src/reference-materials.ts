import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TaskEnvelope } from '../../agent-protocol/src/index.js';

const maxPromptBytes=192*1024;
const utf8Text=/\.(?:md|markdown|txt|text|csv|tsv|json|jsonl|ya?ml|xml|html?|log)$/i;

/** Synthesis has no shell. Read only explicit bindings beneath this node's input directory. */
export async function readReferences(envelope:TaskEnvelope):Promise<Array<{name:string;text:string}>> {
  const files=envelope.input.referenceMaterials??[];
  if (!Array.isArray(files)||files.some(f=>typeof f!=='string')) throw new Error('参考资料必须是绑定的文本路径数组。');
  if (!files.length) return [];
  const root=await realpath(envelope.workspacePath);
  const inputRoot=join(root,'input');
  const result:Array<{name:string;text:string}>=[];
  let size=0;
  for(const file of new Set(files as string[])){
    const absolute=resolve(root,file), inside=relative(inputRoot,absolute);
    if(isAbsolute(file)||!inside||inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside)||
      await realpath(absolute)!==absolute) throw new Error('仅可读取此节点被授权的 input 目录中的普通文件。');
    const meta=envelope.taskInputs?.find(item=>resolve(root,item.path)===absolute);
    if(inside.startsWith('task-inputs'+sep) && !meta) throw new Error('参考资料缺少本节点的任务授权。');
    const stat=await lstat(absolute);
    if(!stat.isFile()||!utf8Text.test(file)) throw new Error('该文本智能体只能读取 UTF-8 文本资料，当前文件需要支持相应格式的能力。');
    if(size+stat.size>maxPromptBytes) throw new Error('文本资料超过本节点 192 KiB 的上下文限制，请缩小资料范围或分步处理。');
    const bytes=await readFile(absolute);
    size+=bytes.length;
    if(size>maxPromptBytes || (meta && (meta.sizeBytes!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)))
      throw new Error('文本资料大小或内容摘要校验失败。');
    let text:string;
    try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new Error('参考资料并非有效的 UTF-8 文本。'); }
    if(text.includes('\0')) throw new Error('参考资料包含二进制内容，文本智能体无法解析。');
    result.push({name:meta?.displayName??inside,text});
  }
  return result;
}
