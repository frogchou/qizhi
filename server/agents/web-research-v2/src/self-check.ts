import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const name of ['discovery','synthesis','input.schema','result.schema']) {
  JSON.parse(readFileSync(join(__dirname, '..', 'schemas', name + '.json'), 'utf8'));
}
const help = execFileSync('codex', ['--search','exec','--help'], { encoding: 'utf8', timeout: 10000 });
if (!help.includes('--output-schema') || !help.includes('--json')) throw new Error('Codex 缺少结构化研究所需的命令选项');
