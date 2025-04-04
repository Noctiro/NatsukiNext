/**
 * 回调数据构建器
 * 帮助创建、解析和验证具有结构化格式的回调数据
 * 格式: `pluginName:actionType:field1:field2:...`
 */
export class CallbackDataBuilder<T extends Record<string, string | number | boolean>> {
    private readonly fullPrefix: string;

    /**
     * 创建一个新的回调数据构建器
     * @param pluginName 插件名称，用于确保全局唯一性
     * @param actionType 功能类型，用于在插件内区分不同操作
     * @param fields 回调数据字段列表，按顺序定义
     */
    constructor(
        private readonly pluginName: string,
        private readonly actionType: string,
        private readonly fields: (keyof T)[]
    ) {
        this.fullPrefix = `${pluginName}:${actionType}`;
    }

    /**
     * 获取完整前缀（插件名:功能名）
     */
    get prefix(): string {
        return this.fullPrefix;
    }

    /**
     * 生成回调数据字符串
     * @param data 要序列化的数据对象
     * @returns 格式化的回调数据字符串
     */
    build(data: T): string {
        const parts = [this.fullPrefix];

        for (const field of this.fields) {
            const value = data[field];
            parts.push(value !== undefined ? String(value) : '');
        }

        return parts.join(':');
    }

    /**
     * 解析回调数据字符串
     * @param data 要解析的回调数据字符串
     * @returns 解析后的数据对象，如果前缀不匹配则返回null
     */
    parse(data: string): T | null {
        if (!data.startsWith(this.fullPrefix + ':')) return null;

        const parts = data.split(':');
        const result = {} as T;

        // 跳过插件名和功能类型（前两个部分）
        parts.splice(0, 2);

        for (let i = 0; i < this.fields.length; i++) {
            const field = this.fields[i];
            const value = parts[i] || '';

            // 尝试推断类型
            if (value === 'true' || value === 'false') {
                // 布尔值
                (result as any)[field] = value === 'true';
            } else if (/^\d+$/.test(value)) {
                // 数字
                (result as any)[field] = parseInt(value, 10);
            } else {
                // 字符串
                (result as any)[field] = value;
            }
        }

        return result;
    }

    /**
     * 创建一个匹配函数，用于验证回调数据
     * @param match 匹配条件，可以指定特定字段的值
     * @returns 一个函数，当数据匹配时返回true
     */
    match(match: Partial<T> = {}): (data: string) => boolean {
        return (data: string) => {
            const parsed = this.parse(data);
            if (!parsed) return false;

            for (const key in match) {
                if (match[key] !== undefined && parsed[key] !== match[key]) {
                    return false;
                }
            }

            return true;
        };
    }

    /**
     * 创建一个过滤器函数，用于分发器过滤回调
     * @param match 匹配条件
     * @returns 过滤器函数
     */
    filter(match: Partial<T> = {}): (context: any) => boolean {
        const matchFn = this.match(match);
        
        return (context: any) => {
            if (context.type !== 'callback') return false;
            
            const data = context.data;
            if (!data) return false;
            
            const result = matchFn(data);
            if (result) {
                // 注入match属性
                const parsed = this.parse(data);
                if (parsed) {
                    // 添加元数据
                    (context as any).match = {
                        ...parsed,
                        _pluginName: this.pluginName,
                        _actionType: this.actionType
                    };
                }
            }
            
            return result;
        };
    }
}

/**
 * 创建特定插件的回调数据构建器工厂
 * @param pluginName 插件名称
 * @returns 工厂函数，用于创建该插件的回调数据构建器
 */
export function createCallbackFactory(pluginName: string) {
    return function<T extends Record<string, string | number | boolean>>(
        actionType: string,
        fields: (keyof T)[]
    ): CallbackDataBuilder<T> {
        return new CallbackDataBuilder<T>(pluginName, actionType, fields);
    };
}

/**
 * 翻译插件回调数据构建器工厂
 */
export const translatorCallbacks = createCallbackFactory('tr'); 