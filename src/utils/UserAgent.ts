/**
 * 高性能随机UserAgent生成器
 * 支持生成Chrome、Firefox、Safari、Edge等主流浏览器的UserAgent字符串
 */

// 定义浏览器类型
type BrowserType = 'chrome' | 'firefox' | 'safari' | 'edge' | 'random';

// 预定义常量以提高性能
const CHROME_VERSIONS = Array.from({length: 31}, (_, i) => 90 + i); // 90-120
const FIREFOX_VERSIONS = Array.from({length: 31}, (_, i) => 90 + i); // 90-120
const SAFARI_MAJOR_VERSIONS = Array.from({length: 6}, (_, i) => 12 + i); // 12-17
const SAFARI_MINOR_VERSIONS = [0, 1, 2, 3];
const SAFARI_SUB_VERSIONS = Array.from({length: 15}, (_, i) => i + 1); // 1-15
const WINDOWS_VERSIONS = ['6.0', '6.1', '6.2', '6.3', '10.0', '11.0'];
const MAC_OS_VERSIONS = Array.from({length: 6}, (_, i) => `10_${10 + i}`); // 10_10 to 10_15
const MAC_OS_MINOR_VERSIONS = Array.from({length: 8}, (_, i) => i); // 0-7

// 缓存平台字符串以减少字符串连接操作
const WINDOWS_PLATFORMS = WINDOWS_VERSIONS.map(v => `Windows NT ${v}`);
const MAC_PLATFORMS = MAC_OS_VERSIONS.flatMap(v => 
  MAC_OS_MINOR_VERSIONS.map(minor => `Macintosh; Intel Mac OS X ${v}_${minor}`)
);
const LINUX_PLATFORMS = ['X11; Linux x86_64'];
const ALL_PLATFORMS = [...WINDOWS_PLATFORMS, ...MAC_PLATFORMS, ...LINUX_PLATFORMS];

/**
 * 从数组中随机选择一个元素
 * @param arr 源数组
 * @throws 如果数组为空，将抛出错误
 */
function getRandomElement<T>(arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error('Cannot get random element from empty array');
  }
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * 生成Chrome浏览器的UserAgent
 */
function generateChromeUA(): string {
  const majorVersion = getRandomElement(CHROME_VERSIONS);
  const minorVersion = Math.floor(Math.random() * 10);
  const buildVersion = Math.floor(Math.random() * 9000) + 1000;
  const platform = getRandomElement(ALL_PLATFORMS);
  
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.${minorVersion}.${buildVersion} Safari/537.36`;
}

/**
 * 生成Firefox浏览器的UserAgent
 */
function generateFirefoxUA(): string {
  const majorVersion = getRandomElement(FIREFOX_VERSIONS);
  const minorVersion = Math.floor(Math.random() * 10);
  const platform = getRandomElement(ALL_PLATFORMS);
  
  return `Mozilla/5.0 (${platform}; rv:${majorVersion}.${minorVersion}) Gecko/20100101 Firefox/${majorVersion}.${minorVersion}`;
}

/**
 * 生成Safari浏览器的UserAgent
 */
function generateSafariUA(): string {
  const majorVersion = getRandomElement(SAFARI_MAJOR_VERSIONS);
  const minorVersion = getRandomElement(SAFARI_MINOR_VERSIONS);
  const subVersion = getRandomElement(SAFARI_SUB_VERSIONS);
  
  // Safari主要在Mac上，所以只使用Mac平台
  const macPlatform = getRandomElement(MAC_PLATFORMS);
  
  return `Mozilla/5.0 (${macPlatform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${majorVersion}.${minorVersion}.${subVersion} Safari/605.1.15`;
}

/**
 * 生成Edge浏览器的UserAgent
 */
function generateEdgeUA(): string {
  const majorVersion = getRandomElement(CHROME_VERSIONS);
  const minorVersion = Math.floor(Math.random() * 10);
  const buildVersion = Math.floor(Math.random() * 9000) + 1000;
  const edgeMinorVersion = Math.floor(Math.random() * 90) + 10;
  const platform = getRandomElement(ALL_PLATFORMS);
  
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.${minorVersion}.${buildVersion} Safari/537.36 Edg/${majorVersion}.0.${minorVersion}.${edgeMinorVersion}`;
}

// 用于快速选择的浏览器函数映射
const BROWSER_GENERATOR_MAP = {
  chrome: generateChromeUA,
  firefox: generateFirefoxUA,
  safari: generateSafariUA,
  edge: generateEdgeUA
} as const;

// 浏览器类型数组，用于随机选择
const BROWSER_TYPES: readonly (keyof typeof BROWSER_GENERATOR_MAP)[] = ['chrome', 'firefox', 'safari', 'edge'];

/**
 * 生成随机UserAgent
 * @param browserType 浏览器类型，默认为随机浏览器
 * @returns UserAgent字符串
 */
export function generateRandomUserAgent(browserType: BrowserType = 'random'): string {
  // 如果是随机类型，则随机选择一种浏览器
  if (browserType === 'random') {
    browserType = getRandomElement(BROWSER_TYPES);
  }
  
  // 使用映射直接调用对应函数
  if (browserType in BROWSER_GENERATOR_MAP) {
    return BROWSER_GENERATOR_MAP[browserType as keyof typeof BROWSER_GENERATOR_MAP]();
  }
  
  // 默认返回Chrome UserAgent（理论上不会执行到这里）
  return generateChromeUA();
}

// 直接导出各种生成函数，方便单独使用
export {
  generateChromeUA,
  generateFirefoxUA,
  generateSafariUA,
  generateEdgeUA
};
