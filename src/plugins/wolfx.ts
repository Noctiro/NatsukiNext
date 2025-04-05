import type { BotPlugin, CommandContext } from "../features";
import { enableChats } from "../app";
import WebSocket from 'ws';

// 确保WebSocket常量可用
const WebSocketStates = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
};

// 区域时区映射
const TIMEZONE_MAPPING = {
    'Asia/Tokyo': 9, // 日本 (UTC+9)
    'Asia/Shanghai': 8, // 中国 (UTC+8)
    'Asia/Taipei': 8 // 台湾 (UTC+8)
};

// 定义统一的地震数据接口
interface EarthquakeData {
    // 日本气象厅EEW
    jma_eew?: {
        Title?: string;
        CodeType?: string;
        Serial: number;
        AnnouncedTime: string;
        OriginTime: string;
        Hypocenter: string;
        Latitude: number;
        Longitude: number;
        Magunitude: number;
        Depth: number;
        MaxIntensity: string;
        isTraining: boolean;
        isAssumption: boolean;
        isWarn: boolean;
        isFinal: boolean;
        isCancel: boolean;
        OriginalText: string;
    };

    // 日本地震列表
    jma_eqlist?: {
        md5: string;
        No1?: {
            time: string;
            location: string;
            magnitude: number;
            depth: string;
            latitude: number;
            longitude: number;
            shindo: string;
            info: string;
        }
    };

    // 福建地震预警
    fj_eew?: {
        EventID: string;
        ReportTime: string;
        ReportNum: number;
        OriginTime: string;
        HypoCenter: string;
        Latitude: number;
        Longitude: number;
        Magunitude: number;
        Depth: number | null;
        isFinal: boolean;
    };

    // 四川地震预警
    sc_eew?: {
        EventID: string;
        ReportTime: string;
        ReportNum: number;
        OriginTime: string;
        HypoCenter: string;
        Latitude: number;
        Longitude: number;
        Magunitude: number;
        Depth: number | null;
        MaxIntensity: string;
    };

    // 台湾气象局预警
    cwa_eew?: {
        ID: string;
        ReportTime: string;
        ReportNum: number;
        OriginTime: string;
        HypoCenter: string;
        Latitude: number;
        Longitude: number;
        Magunitude: number;
        Depth: number;
    };

    // 中国地震台网
    cenc_eqlist?: {
        md5: string;
        No1?: {
            type: 'automatic' | 'reviewed';
            time: string;
            location: string;
            magnitude: number;
            depth: string;
            latitude: number;
            longitude: number;
            intensity?: string;
        }
    };
}

// 配置参数
const CONFIG = {
    magThreshold: 3,     // 震级阈值(大于等于此值才播报)
    httpDelay: 5 * 1000, // HTTP轮询间隔
    httpTimeout: 5000,   // HTTP请求超时时间

    // 统一API地址
    httpApi: 'https://api.wolfx.jp/mceew_data.json',
    wsApi: 'wss://ws-api.wolfx.jp/all_eew',

    reconnectDelay: 5000, // 重连延迟
    maxReconnectAttempts: 5 // 最大重连次数
};

// 全局状态
class EarthquakeService {
    // 上一次发送的消息ID(每个聊天一个数组)
    private lastSendMsgsMap = new Map<number, Promise<any>[]>();

    // 工作模式和连接状态
    private mode: 'HTTP' | 'WebSocket' = 'HTTP';
    private forceMode?: 'HTTP' | 'WebSocket';

    // WebSocket连接
    private socket: WebSocket | null = null;
    private reconnectAttempts = 0;
    private webSocketPing: number = 0;
    
    // 事件监听器引用，用于清理
    private listeners = {
        open: null as ((event: any) => void) | null,
        message: null as ((event: any) => void) | null,
        close: null as ((event: any) => void) | null,
        error: null as ((event: any) => void) | null
    };

    // HTTP轮询
    private httpInterval: ReturnType<typeof setInterval> | null = null;
    private lastDataTimestamp: number = 0;
    private httpController: AbortController | null = null;

    // 数据标识符(用于避免重复通知)
    private jmaOriginalText?: string;
    private jmaFinalMd5?: string;
    private fjEventID?: string;
    private scEventID?: string;
    private cwaTS?: string;
    private cencMd5?: string;

    // 数据缓存
    private data: EarthquakeData = {};

    // Telegram客户端引用
    private client: any;

    // 初始化
    constructor() { }

    /**
     * 获取格式化的时间字符串
     */
    private formatDateTime(date: Date | string, timezone: keyof typeof TIMEZONE_MAPPING, includeSeconds = true): string {
        const dt = date instanceof Date ? date : new Date(date);
        const offset = TIMEZONE_MAPPING[timezone] * 60;
        const localTime = new Date(dt.getTime() + offset * 60000);

        const year = localTime.getUTCFullYear();
        const month = String(localTime.getUTCMonth() + 1).padStart(2, '0');
        const day = String(localTime.getUTCDate()).padStart(2, '0');
        const hour = String(localTime.getUTCHours()).padStart(2, '0');
        const minute = String(localTime.getUTCMinutes()).padStart(2, '0');

        if (includeSeconds) {
            const second = String(localTime.getUTCSeconds()).padStart(2, '0');
            return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
        }

        return `${year}/${month}/${day} ${hour}:${minute}`;
    }

    /**
     * 通过HTTP获取数据
     */
    private async fetchData() {
        try {
            // 取消之前的请求（如果有）
            if (this.httpController) {
                this.httpController.abort();
            }
            
            this.httpController = new AbortController();
            const timeoutId = setTimeout(() => {
                if (this.httpController) {
                    this.httpController.abort();
                }
            }, CONFIG.httpTimeout);

            const startTime = Date.now();
            const response = await fetch(CONFIG.httpApi, {
                signal: this.httpController.signal,
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            const requestTime = Date.now() - startTime;

            clearTimeout(timeoutId);
            this.lastDataTimestamp = Date.now();

            if (!response.ok) {
                throw new Error(`HTTP请求失败: ${response.status}`);
            }

            plugin.logger?.debug(`HTTP数据获取成功，耗时: ${requestTime}ms`);

            // 获取新数据并处理
            const responseData = await response.json();
            
            // 检查数据有效性
            if (!responseData || typeof responseData !== 'object') {
                throw new Error('收到的数据格式无效');
            }
            
            this.data = responseData;

            // 处理各种地震数据
            this.processJmaEew();
            this.processJmaEqlist();
            this.processFjEew();
            this.processScEew();
            this.processCwaEew();
            this.processCencEqlist();
        } catch (error) {
            // 仅在非中止错误时记录
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                plugin.logger?.error(`HTTP请求失败: ${error}`);
            }
        } finally {
            this.httpController = null;
        }
    }

    /**
     * 建立WebSocket连接
     */
    private connectWebSocket() {
        // 检查现有连接
        if (this.socket && (this.socket.readyState === WebSocketStates.OPEN ||
            this.socket.readyState === WebSocketStates.CONNECTING)) {
            return;
        }

        // 超出最大重连次数，切换回HTTP模式
        if (this.reconnectAttempts > CONFIG.maxReconnectAttempts && !this.forceMode) {
            plugin.logger?.warn(`WebSocket重连次数超过上限(${CONFIG.maxReconnectAttempts}次)，切换回HTTP模式`);
            this.startHttpPolling();
            this.reconnectAttempts = 0;
            return;
        }

        try {
            // 清理之前的WebSocket连接
            this.closeAllWebSockets();
            
            plugin.logger?.info(`尝试建立WebSocket连接(第${this.reconnectAttempts + 1}次)`);
            this.socket = new WebSocket(CONFIG.wsApi);

            // 更新重连计数
            this.reconnectAttempts++;

            // 定义事件处理器并保存引用，以便后续清理
            this.listeners.open = () => {
                plugin.logger?.info(`WebSocket连接已建立`);
                this.mode = 'WebSocket';
                this.reconnectAttempts = 0;
                this.lastDataTimestamp = Date.now();

                // 停止HTTP轮询
                this.stopHttpPolling();
            };

            this.listeners.message = (event: any) => {
                try {
                    // 安全地解析消息数据
                    const rawData = event.data;
                    if (!rawData) {
                        plugin.logger?.warn('收到空WebSocket消息');
                        return;
                    }
                    
                    const message = JSON.parse(typeof rawData === 'string' ? rawData : rawData.toString());

                    // 处理心跳和延迟测量
                    if (message && 'type' in message && (message.type === 'heartbeat' || message.type === 'pong')) {
                        const now = Date.now();
                        this.webSocketPing = now - message.timestamp;

                        if (this.webSocketPing >= 500) {
                            plugin.logger?.warn(`WebSocket延迟过高: ${this.webSocketPing}ms`);
                        }
                        return;
                    }

                    // 验证数据结构
                    if (!message || typeof message !== 'object') {
                        plugin.logger?.warn('收到的WebSocket消息格式无效');
                        return;
                    }

                    // 更新数据缓存
                    this.data = message;
                    this.lastDataTimestamp = Date.now();

                    // 处理各种地震数据
                    this.processJmaEew();
                    this.processJmaEqlist();
                    this.processFjEew();
                    this.processScEew();
                    this.processCwaEew();
                    this.processCencEqlist();
                } catch (error) {
                    plugin.logger?.error(`WebSocket消息处理错误: ${error}`);
                }
            };

            this.listeners.close = (event: any) => {
                const reason = event?.reason ? `: ${event.reason}` : '';
                const code = event?.code || 'unknown';
                plugin.logger?.info(`WebSocket连接已关闭，代码: ${code}${reason}`);

                // 启动HTTP轮询作为备份
                this.startHttpPolling();

                // 只有在非强制HTTP模式下才尝试重连
                if (this.forceMode !== 'HTTP') {
                    setTimeout(() => this.connectWebSocket(), CONFIG.reconnectDelay);
                }
            };

            this.listeners.error = (error: any) => {
                plugin.logger?.error(`WebSocket连接错误: ${error}`);

                // 启动HTTP轮询作为备份
                this.startHttpPolling();
                
                // 关闭错误的连接
                this.closeAllWebSockets();

                // 只有在非强制HTTP模式下才尝试重连
                if (this.forceMode !== 'HTTP') {
                    setTimeout(() => this.connectWebSocket(), CONFIG.reconnectDelay);
                }
            };

            // 绑定事件监听器
            if (this.listeners.open) this.socket.addEventListener('open', this.listeners.open);
            if (this.listeners.message) this.socket.addEventListener('message', this.listeners.message);
            if (this.listeners.close) this.socket.addEventListener('close', this.listeners.close);
            if (this.listeners.error) this.socket.addEventListener('error', this.listeners.error);
            
            // 设置连接超时
            setTimeout(() => {
                if (this.socket && this.socket.readyState === WebSocketStates.CONNECTING) {
                    plugin.logger?.warn('WebSocket连接超时');
                    this.closeAllWebSockets();
                    
                    if (this.forceMode !== 'HTTP') {
                        setTimeout(() => this.connectWebSocket(), CONFIG.reconnectDelay);
                    }
                }
            }, CONFIG.httpTimeout); // 使用相同的超时时间
            
        } catch (error) {
            plugin.logger?.error(`创建WebSocket连接失败: ${error}`);

            // 启动HTTP轮询作为备份
            this.startHttpPolling();

            // 只有在非强制HTTP模式下才尝试重连
            if (this.forceMode !== 'HTTP') {
                setTimeout(() => this.connectWebSocket(), CONFIG.reconnectDelay);
            }
        }
    }

    /**
     * 启动HTTP轮询
     */
    private startHttpPolling() {
        // 避免重复启动
        this.stopHttpPolling();

        // 立即获取一次数据
        this.fetchData();

        // 设置定时获取
        this.httpInterval = setInterval(() => {
            if (this.mode === 'HTTP' || this.forceMode === 'HTTP') {
                this.fetchData();
            }
        }, CONFIG.httpDelay);
    }

    /**
     * 停止HTTP轮询
     */
    private stopHttpPolling() {
        if (this.httpInterval) {
            clearInterval(this.httpInterval);
            this.httpInterval = null;
        }
        
        // 取消正在进行的请求
        if (this.httpController) {
            this.httpController.abort();
            this.httpController = null;
        }
    }

    /**
     * 向所有启用的聊天发送地震信息
     */
    private async sendEarthquakeInfo(text: string, lat: number, lon: number) {
        if (!enableChats || enableChats.length === 0) {
            plugin.logger?.warn('没有启用接收地震信息的聊天');
            return;
        }
        
        // 确保坐标有效
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            plugin.logger?.error(`无效的地理坐标: 纬度=${lat}, 经度=${lon}`);
            return;
        }

        for (const chatId of enableChats) {
            try {
                // 发送位置和消息
                const locMsg = await this.sendLocation(chatId, lat, lon);
                await this.sendMessage(chatId, text);

                // 获取上一次发送的消息列表
                if (!this.lastSendMsgsMap.has(chatId)) {
                    this.lastSendMsgsMap.set(chatId, []);
                }

                const lastSendMsgs = this.lastSendMsgsMap.get(chatId)!;

                // 清理旧消息
                if (lastSendMsgs.length > 0) {
                    const deletePromises: Promise<any>[] = [];
                    
                    for (let i = lastSendMsgs.length - 1; i >= 0; i--) {
                        try {
                            const msg = await lastSendMsgs[i];
                            if (msg && msg.id) {
                                deletePromises.push(this.deleteMessage(chatId, msg.id));
                            }
                            lastSendMsgs.splice(i, 1);
                        } catch (error) {
                            plugin.logger?.error(`删除消息失败: ${error}`);
                            lastSendMsgs.splice(i, 1);
                        }
                    }
                    
                    // 并行处理所有删除请求
                    await Promise.allSettled(deletePromises);
                }

                // 添加新消息到列表，限制保存的消息数量，防止内存泄漏
                lastSendMsgs.push(locMsg);
                if (lastSendMsgs.length > 10) {
                    lastSendMsgs.shift(); // 删除最旧的消息
                }
            } catch (error) {
                plugin.logger?.error(`向聊天 ${chatId} 发送地震信息失败: ${error}`);
            }
        }
    }

    /**
     * 发送位置消息
     */
    private async sendLocation(chatId: number, lat: number, lon: number): Promise<any> {
        return this.client.sendLocation({
            chatId: chatId,
            latitude: lat,
            longitude: lon
        });
    }

    /**
     * 发送文本消息
     */
    private async sendMessage(chatId: number, text: string): Promise<any> {
        return this.client.sendMessage({
            chatId: chatId,
            text: text
        });
    }

    /**
     * 删除消息
     */
    private async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
        try {
            return await this.client.deleteMessages({
                chatId: chatId,
                ids: [messageId]
            });
        } catch (error) {
            plugin.logger?.error(`删除消息失败: ${error}`);
            return false;
        }
    }

    /**
     * 检查数据是否满足通知条件
     * @param currentId 当前数据ID
     * @param lastId 上次处理的ID
     * @param magnitude 震级
     * @returns 是否应该发送通知
     */
    private shouldSendNotification(currentId: string | undefined, lastId: string | undefined, magnitude: number): boolean {
        return !!lastId && !!currentId && currentId !== lastId && magnitude >= CONFIG.magThreshold;
    }

    /**
     * 处理日本气象厅紧急地震速报
     */
    private processJmaEew() {
        // 检查数据是否有更新
        if (!this.data.jma_eew || this.data.jma_eew.OriginalText === this.jmaOriginalText) {
            return;
        }

        const data = this.data.jma_eew;

        // 获取所需字段
        const flag = data.Title?.substring(7, 9) || "";
        const reportTime = data.AnnouncedTime;
        const num = data.Serial;
        const lat = data.Latitude;
        const lon = data.Longitude;
        const region = data.Hypocenter;
        const mag = data.Magunitude;
        const depth = data.Depth + "km";
        const shindo = data.MaxIntensity;
        const originTime = this.formatDateTime(data.OriginTime, 'Asia/Tokyo');

        // 构建报文类型信息
        let type = "";
        if (data.isTraining) {
            type = "訓練";
        } else if (data.isAssumption) {
            type = "仮定震源";
        }

        if (data.isFinal) {
            type = type ? `${type} (最終報)` : "最終報";
        }

        if (data.isCancel) {
            type = "取消";
        }

        // 检查是否满足通知条件
        if (this.shouldSendNotification(data.OriginalText, this.jmaOriginalText, mag)) {
            this.sendEarthquakeInfo(`緊急地震速報 (${flag}) | 第${num}報 ${type}
${originTime} 発生
震央: ${region} (北緯: ${lat}度 東経: ${lon}度)
マグニチュード: ${mag}
深さ: ${depth}
最大震度: ${shindo}
更新時間: ${reportTime}`, lat, lon);
        }

        // 更新标识符
        this.jmaOriginalText = data.OriginalText;
    }

    /**
     * 处理日本气象厅地震列表
     */
    private processJmaEqlist() {
        if (!this.data.jma_eqlist || this.data.jma_eqlist.md5 === this.jmaFinalMd5) {
            return;
        }

        const data = this.data.jma_eqlist;
        const info = data.No1;

        if (!info) return;

        // 获取所需字段
        const timeStr = info.time;
        const region = info.location;
        const mag = info.magnitude;
        const depth = info.depth;
        const lat = info.latitude;
        const lon = info.longitude;
        const shindo = info.shindo;
        const tsunamiInfo = info.info;
        const originTime = this.formatDateTime(timeStr, 'Asia/Tokyo', false);

        // 检查是否满足通知条件
        if (this.shouldSendNotification(data.md5, this.jmaFinalMd5, mag)) {
            this.sendEarthquakeInfo(`地震情報
${originTime} 発生
震央: ${region} (北緯: ${lat}度 東経: ${lon}度)
マグニチュード: ${mag}
深さ: ${depth}
最大震度: ${shindo}
津波情報: ${tsunamiInfo}`, lat, lon);
        }

        // 更新标识符
        this.jmaFinalMd5 = data.md5;
    }

    /**
     * 处理福建地震预警
     */
    private processFjEew() {
        if (!this.data.fj_eew || this.data.fj_eew.EventID === this.fjEventID) {
            return;
        }

        const data = this.data.fj_eew;

        // 获取所需字段
        const reportTime = data.ReportTime;
        const num = data.ReportNum;
        const lat = data.Latitude;
        const lon = data.Longitude;
        const region = data.HypoCenter;
        const mag = data.Magunitude;
        const depth = data.Depth !== null ? `${data.Depth}km` : '10km';
        const originTime = this.formatDateTime(data.OriginTime, 'Asia/Shanghai');
        const finalTag = data.isFinal ? " 最终报" : "";

        // 检查是否满足通知条件
        if (this.shouldSendNotification(data.EventID, this.fjEventID, mag)) {
            this.sendEarthquakeInfo(`福建地震预警 | 第${num}报${finalTag}
${originTime} 发生
震中: ${region} (北纬: ${lat}度 东经: ${lon}度)
震级: ${mag}
深度: ${depth}
更新时间: ${reportTime}`, lat, lon);
        }

        // 更新标识符
        this.fjEventID = data.EventID;
    }

    /**
     * 处理四川地震预警
     */
    private processScEew() {
        if (!this.data.sc_eew || this.data.sc_eew.EventID === this.scEventID) {
            return;
        }

        const data = this.data.sc_eew;

        // 获取所需字段
        const reportTime = data.ReportTime;
        const num = data.ReportNum;
        const lat = data.Latitude;
        const lon = data.Longitude;
        const region = data.HypoCenter;
        const mag = data.Magunitude;
        const depth = data.Depth !== null ? `${data.Depth}km` : '10km';
        const intensity = Math.round(parseFloat(data.MaxIntensity)).toString();
        const originTime = this.formatDateTime(data.OriginTime, 'Asia/Shanghai');

        // 检查是否满足通知条件
        if (this.shouldSendNotification(data.EventID, this.scEventID, mag)) {
            this.sendEarthquakeInfo(`四川地震预警 | 第${num}报
${originTime} 发生
震中: ${region} (北纬: ${lat}度 东经: ${lon}度)
震级: ${mag}
深度: ${depth}
最大烈度: ${intensity}
更新时间: ${reportTime}`, lat, lon);
        }

        // 更新标识符
        this.scEventID = data.EventID;
    }

    /**
     * 处理台湾气象局预警
     */
    private processCwaEew() {
        if (!this.data.cwa_eew || this.data.cwa_eew.ReportTime === this.cwaTS) {
            return;
        }

        const data = this.data.cwa_eew;

        // 获取所需字段
        const reportTime = data.ReportTime;
        const num = data.ReportNum;
        const lat = data.Latitude;
        const lon = data.Longitude;
        const region = data.HypoCenter;
        const mag = data.Magunitude;
        const depth = `${data.Depth}km`;
        const originTime = this.formatDateTime(data.OriginTime, 'Asia/Taipei');

        // 检查是否满足通知条件
        if (this.shouldSendNotification(data.ReportTime, this.cwaTS, mag)) {
            this.sendEarthquakeInfo(`台灣地震預警 | 第${num}報
${originTime} 發生
震央: ${region} (北緯: ${lat}度 東經: ${lon}度)
規模: ${mag}
深度: ${depth}
更新時間: ${reportTime}`, lat, lon);
        }

        // 更新标识符
        this.cwaTS = data.ReportTime;
    }

    /**
     * 处理中国地震台网
     */
    private processCencEqlist() {
        if (!this.data.cenc_eqlist || this.data.cenc_eqlist.md5 === this.cencMd5) {
            return;
        }

        const data = this.data.cenc_eqlist;
        const info = data.No1;

        if (!info) return;

        // 获取所需字段
        const timeStr = info.time;
        const region = info.location;
        const mag = info.magnitude;
        const depth = info.depth;
        const lat = info.latitude;
        const lon = info.longitude;
        const originTime = this.formatDateTime(timeStr, 'Asia/Shanghai', false);
        const type = info.type === "automatic" ? "自动发布" : "人工发布";

        // 检查是否满足通知条件
        if (this.shouldSendNotification(data.md5, this.cencMd5, mag)) {
            this.sendEarthquakeInfo(`中国地震台网 | ${type}
${originTime} 发生
震源地: ${region} (北纬: ${lat}度 东经: ${lon}度)
震级: ${mag}
震源深度: ${depth}`, lat, lon);
        }

        // 更新标识符
        this.cencMd5 = data.md5;
    }

    /**
     * 获取插件状态信息
     */
    public getStatusInfo(detailed: boolean = false): string {
        let content = 'Wolfx防灾(防災)预警 工作中';

        // 当前工作模式
        if (this.mode === 'HTTP') {
            content += '\n模式: HTTP';
            if (this.forceMode === 'HTTP') {
                content += ' (强制模式)';
            }

            // 详细模式显示上次数据获取时间
            if (detailed) {
                const avgTime = Math.floor((Date.now() - this.lastDataTimestamp) / 1000);
                const lastUpdateTime = avgTime > 0 ? `${avgTime}秒前` : '从未';
                content += `\n上次数据更新: ${lastUpdateTime}`;
            }
        } else {
            content += `\n模式: WebSocket`;
            if (this.forceMode === 'WebSocket') {
                content += ' (强制模式)';
            }
            content += `\nWebSocket延迟: ${this.webSocketPing}ms`;

            // 详细模式显示更多信息
            if (detailed) {
                content += `\n重连尝试: ${this.reconnectAttempts}/${CONFIG.maxReconnectAttempts}`;

                // 显示上次数据更新时间
                const avgTime = Math.floor((Date.now() - this.lastDataTimestamp) / 1000);
                const lastUpdateTime = avgTime > 0 ? `${avgTime}秒前` : '从未';
                content += `\n上次数据更新: ${lastUpdateTime}`;
            }
        }

        // 详细模式显示更多信息
        if (detailed) {
            content += `\n\n监控震级阈值: M${CONFIG.magThreshold}+`;

            // 显示数据源状态
            content += '\n\n数据源状态:';
            content += `\n日本气象厅EEW: ${this.data.jma_eew ? '✅' : '❌'}`;
            content += `\n日本气象厅地震列表: ${this.data.jma_eqlist ? '✅' : '❌'}`;
            content += `\n福建地震预警: ${this.data.fj_eew ? '✅' : '❌'}`;
            content += `\n四川地震预警: ${this.data.sc_eew ? '✅' : '❌'}`;
            content += `\n台湾气象局预警: ${this.data.cwa_eew ? '✅' : '❌'}`;
            content += `\n中国地震台网: ${this.data.cenc_eqlist ? '✅' : '❌'}`;

            // HTTP和WebSocket状态
            content += `\n\nAPI状态:`;
            content += `\nHTTP API: ${this.httpInterval ? '轮询中' : '未启动'}`;
            content += `\nWebSocket: ${this.socket ? (['连接中', '已连接', '关闭中', '已关闭'][this.socket.readyState]) : '未连接'}`;

            // 启用的聊天数量
            content += `\n\n已启用预警的聊天: ${enableChats.length} 个`;
        }

        return content;
    }

    /**
     * 初始化服务
     */
    public async initialize(client: any): Promise<void> {
        this.client = client;

        // 根据模式启动服务
        if (this.forceMode === 'HTTP' || !this.forceMode) {
            plugin.logger?.info("启动HTTP轮询服务");
            this.startHttpPolling();
        }

        if (this.forceMode === 'WebSocket' || !this.forceMode) {
            plugin.logger?.info("尝试建立WebSocket连接");
            this.connectWebSocket();
        }

        plugin.logger?.info("Wolfx防灾预警服务已初始化");
    }

    /**
     * 停止服务
     */
    public shutdown(): void {
        // 停止HTTP轮询
        this.stopHttpPolling();

        // 关闭WebSocket连接
        this.closeAllWebSockets();
        
        // 清理消息映射
        this.lastSendMsgsMap.clear();

        plugin.logger?.info("Wolfx防灾预警服务已停止");
    }

    /**
     * 手动设置工作模式
     */
    public setMode(mode: 'HTTP' | 'WebSocket' | 'AUTO'): string {
        // 自动模式，清除强制标记
        if (mode === 'AUTO') {
            this.forceMode = undefined;

            // 重置重连计数
            this.reconnectAttempts = 0;

            // 启动两种连接方式，让系统自动选择
            this.startHttpPolling();
            this.connectWebSocket();

            return `已设置为自动模式，将尝试优先使用WebSocket连接`;
        }

        // 设置为HTTP模式
        if (mode === 'HTTP') {
            // 关闭现有WebSocket连接
            this.closeAllWebSockets();

            this.forceMode = 'HTTP';
            this.mode = 'HTTP';

            // 确保HTTP轮询已启动
            this.startHttpPolling();

            return `已切换到HTTP模式`;
        }

        // 设置为WebSocket模式
        if (mode === 'WebSocket') {
            this.forceMode = 'WebSocket';

            // 停止HTTP轮询
            this.stopHttpPolling();

            // 重置重连计数并立即尝试连接
            this.reconnectAttempts = 0;
            this.connectWebSocket();

            return `已切换到WebSocket模式`;
        }

        return `设置模式失败: 无效的模式 ${mode}`;
    }

    /**
     * 关闭WebSocket连接
     */
    private closeAllWebSockets() {
        if (this.socket) {
            // 移除所有事件监听器
            if (this.listeners.open) this.socket.removeEventListener('open', this.listeners.open);
            if (this.listeners.message) this.socket.removeEventListener('message', this.listeners.message);
            if (this.listeners.close) this.socket.removeEventListener('close', this.listeners.close);
            if (this.listeners.error) this.socket.removeEventListener('error', this.listeners.error);
            
            // 关闭连接
            if (this.socket.readyState === WebSocketStates.OPEN ||
                this.socket.readyState === WebSocketStates.CONNECTING) {
                try {
                    this.socket.close();
                    plugin.logger?.info(`关闭WebSocket连接`);
                } catch (error) {
                    plugin.logger?.error(`关闭WebSocket连接出错: ${error}`);
                }
            }
            
            this.socket = null;
        }
        
        // 重置所有监听器
        this.listeners = {
            open: null,
            message: null,
            close: null,
            error: null
        };
    }
}

// 创建单例实例
const earthquakeService = new EarthquakeService();

/**
 * 插件定义
 */
const plugin: BotPlugin = {
    name: 'wolfx',
    description: 'Wolfx防灾预警插件 - 接收地震信息并通知',
    version: '1.0.0',

    // 插件加载时调用
    async onLoad(client) {
        await earthquakeService.initialize(client);
    },

    // 插件卸载时调用
    async onUnload() {
        earthquakeService.shutdown();
    },

    // 注册命令
    commands: [
        {
            name: 'eew',
            description: '查看地震预警系统状态或控制服务',
            aliases: ['earthquake', 'wolfx'],
            async handler(ctx: CommandContext) {
                const subCommand = ctx.args[0]?.toLowerCase();

                // 根据子命令执行相应操作
                switch (subCommand) {
                    case 'status':
                    case 'stat':
                        // 查看详细状态
                        await ctx.message.replyText(earthquakeService.getStatusInfo(true));
                        break;

                    case 'http':
                        // 切换到HTTP模式
                        const httpResult = earthquakeService.setMode('HTTP');
                        await ctx.message.replyText(httpResult);
                        break;

                    case 'ws':
                    case 'websocket':
                        // 切换到WebSocket模式
                        const wsResult = earthquakeService.setMode('WebSocket');
                        await ctx.message.replyText(wsResult);
                        break;

                    case 'auto':
                        // 切换到自动模式
                        const autoResult = earthquakeService.setMode('AUTO');
                        await ctx.message.replyText(autoResult);
                        break;

                    case 'help':
                        // 显示帮助信息
                        await ctx.message.replyText(
                            '🌋 Wolfx防灾预警命令帮助\n\n' +
                            '/eew - 查看基本状态\n' +
                            '/eew status - 查看详细状态\n' +
                            '/eew http - 强制使用HTTP模式\n' +
                            '/eew ws - 强制使用WebSocket模式\n' +
                            '/eew auto - 恢复自动选择连接模式\n' +
                            '/eew help - 显示此帮助信息'
                        );
                        break;

                    default:
                        // 默认显示基本状态
                        await ctx.message.replyText(earthquakeService.getStatusInfo(false));
                        break;
                }
            }
        }
    ]
};

export default plugin; 