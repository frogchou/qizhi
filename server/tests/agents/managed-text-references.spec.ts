import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect } from 'vitest';
import type { TaskEnvelope } from '../../packages/agent-protocol/src/index.js';
import { readReferences } from '../../packages/managed-text/src/reference-materials.js';

describe('synthesis text references',()=>{
  it('returns actual UTF-8 text for the authorized file and rejects altered, binary or escaping inputs',async()=>{
    const root=await mkdtemp(join(tmpdir(),'revision-references-'));
    try {
      await mkdir(join(root,'input','task-inputs'),{recursive:true});
      const path='input/task-inputs/previous.md', text='上版的唯一标识 ACCT-641，保留它。';
      await writeFile(join(root,path),text);
      const input={workspacePath:root,input:{referenceMaterials:[path]},taskInputs:[{path,displayName:'上版报告',
        sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}]};
      expect(await readReferences(input as unknown as TaskEnvelope)).toEqual([{name:'上版报告',text}]);
      await writeFile(join(root,path),'替换');
      await expect(readReferences(input as unknown as TaskEnvelope)).rejects.toThrow('校验失败');
      await expect(readReferences({...input,taskInputs:[]} as unknown as TaskEnvelope)).rejects.toThrow('授权');
      await writeFile(join(root,'input','report.pptx'),Buffer.from([0x50,0x4b,0,1]));
      await expect(readReferences({...input,input:{referenceMaterials:['input/report.pptx']}} as unknown as TaskEnvelope)).rejects.toThrow('相应格式');
      await expect(readReferences({...input,input:{referenceMaterials:['../other']}} as unknown as TaskEnvelope)).rejects.toThrow('input');
      expect(await readReferences({...input,input:{brief:'旧模板'}} as unknown as TaskEnvelope)).toEqual([]);
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
