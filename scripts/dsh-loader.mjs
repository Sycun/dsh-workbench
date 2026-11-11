import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.env.DSH_RUNTIME_ROOT;
if (!root) throw new Error('请设置 DSH_RUNTIME_ROOT 为已安装 DSH 的 package.json 所在目录');
const require = createRequire(join(root, 'package.json'));
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
