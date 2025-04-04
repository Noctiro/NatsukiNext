#!/usr/bin/env node

import fs from 'fs';
const path = require('path');
const { execSync } = require('child_process');

/**
 * 插件预打包脚本
 * 用于解决Bun编译二进制后无法动态加载插件的问题
 * 
 * 工作原理：
 * 1. 扫描所有插件目录
 * 2. 生成一个embedded-plugins.ts文件，其中包含所有插件的导入声明
 * 3. 在Features类中添加一个加载预编译插件的逻辑
 */

// 配置
const PLUGINS_DIR = path.join(__dirname, 'src/plugins');
const OUTPUT_FILE = path.join(__dirname, 'src/embedded-plugins.ts');
const VALID_EXTENSIONS = ['.ts', '.js'];

// 帮助函数：检查目录是否存在
async function dirExists(dirPath) {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch (err) {
    return false;
  }
}

// 帮助函数：规范化路径
function normalizePath(p) {
  return p.split(path.sep).join('/');
}

// 验证是否是有效的插件文件
async function isValidPluginFile(filePath) {
  try {
    // 读取文件内容
    const content = await fs.promises.readFile(filePath, 'utf-8');

    // 简单检查文件是否符合插件格式
    // 插件必须有export default和name属性
    return content.includes('export default') &&
      (content.includes('name:') || content.includes('name =')) &&
      (content.includes('commands:') || content.includes('events:') || content.includes('onLoad'));
  } catch (err) {
    console.error(`验证插件文件失败: ${filePath}`, err);
    return false;
  }
}

// 递归扫描目录，查找所有插件文件
async function scanPluginsDir(dir) {
  const results = [];

  if (!dir || !(await dirExists(dir))) {
    console.warn(`目录不存在: ${dir}`);
    return results;
  }

  try {
    const files = await fs.promises.readdir(dir);

    // 处理每个文件/目录
    for (const file of files) {
      const fullPath = path.join(dir, file);

      if (await dirExists(fullPath)) {
        // 递归扫描子目录
        const subDirPlugins = await scanPluginsDir(fullPath);
        results.push(...subDirPlugins);
      } else if (VALID_EXTENSIONS.some(ext => file.endsWith(ext))) {
        if (await isValidPluginFile(fullPath)) {
          // 计算相对于插件根目录的路径
          const relativePath = path.relative(PLUGINS_DIR, fullPath);
          // 移除扩展名
          const pluginName = normalizePath(relativePath).replace(/\.(ts|js)$/, '');

          results.push({
            name: pluginName,
            path: fullPath
          });
        }
      }
    }
  } catch (err) {
    console.error(`扫描目录失败: ${dir}`, err);
  }

  return results;
}

// 生成预编译插件文件
async function generateEmbeddedPluginsFile(plugins) {
  let content = '';

  // 导入语句
  plugins.forEach((plugin, index) => {
    const importPath = normalizePath(path.relative(path.dirname(OUTPUT_FILE), plugin.path))
      .replace(/\.(ts|js)$/, '');
    content += `import plugin${index} from './${importPath}';\n`;
  });

  content += `
export const embeddedPlugins = new Map<string, any>([
`;

  // 映射语句
  plugins.forEach((plugin, index) => {
    content += `  ['${plugin.name}', plugin${index}],\n`;
  });

  content += `]);

export const embeddedPluginsList = [
${plugins.map(p => `  '${p.name}'`).join(',\n')}
];`;

  // 写入文件
  await fs.promises.writeFile(OUTPUT_FILE, content, 'utf-8');
  console.log(`已生成预编译插件文件: ${OUTPUT_FILE}`);
  console.log(`包含 ${plugins.length} 个插件`);

  return plugins.length;
}

// 主函数
async function main() {
  console.log('开始插件预打包...');

  if (!await dirExists(PLUGINS_DIR)) {
    console.warn(`插件目录不存在: ${PLUGINS_DIR}`);
    await fs.promises.mkdir(PLUGINS_DIR, { recursive: true });
    console.log(`已创建插件目录: ${PLUGINS_DIR}`);
  }

  // 扫描插件目录
  console.log(`正在扫描插件目录: ${PLUGINS_DIR}`);
  const plugins = await scanPluginsDir(PLUGINS_DIR);
  console.log(`找到 ${plugins.length} 个插件`);

  if (plugins.length === 0) {
    console.log('没有找到有效插件，创建空的嵌入式插件文件');
  }

  // 生成嵌入式插件文件
  await generateEmbeddedPluginsFile(plugins);

  // 运行Bun编译命令
  console.log('开始编译...');
  try {
    execSync('bun build src/app.ts --compile --outfile natsuki', {
      stdio: 'inherit'
    });
    console.log('编译完成');
  } catch (err) {
    console.error('编译失败:', err);
  } finally {
    console.log('恢复 embedded-plugins.ts...');
    await fs.promises.writeFile(OUTPUT_FILE, `export const embeddedPlugins = new Map<string, any>([]);
export const embeddedPluginsList = [];`, 'utf-8');
  }
  
  console.log('完成工作流');
}

// 执行主函数
main().catch(err => {
  console.error('出现错误:', err);
  process.exit(1);
});