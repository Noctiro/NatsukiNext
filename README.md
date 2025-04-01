# NatsukiMiyu Next

NatsukiMiyu Next 是一个基于 [mtcute](https://github.com/mtcute/mtcute) 构建的模块化、可扩展的 Telegram 机器人框架。

## 核心特性

- **插件化架构**: 通过独立的插件来组织和管理机器人的功能，易于扩展和维护。
- **强大的事件系统**: 支持消息、命令、回调查询等多种事件类型，并提供优先级和过滤器。
- **灵活的命令处理**: 支持命令别名、冷却时间、权限控制和参数解析。
- **精细的权限管理**: 内置权限系统，可以定义和管理用户及用户组的权限。
- **配置管理**: 每个插件都可以拥有独立的配置文件，并支持默认配置。
- **依赖管理**: 插件可以声明对其他插件的依赖，确保加载顺序。
- **TypeScript 支持**: 使用 TypeScript 编写，提供类型安全和更好的开发体验。

## 插件开发指南

插件是 NatsukiMiyu Next 的核心。下面是一个详细的插件示例，展示了如何使用框架提供的各种功能。

```typescript
// 导入必要的类型和模块
import type {
  BotPlugin,
  CommandContext,
  MessageEventContext,
  CallbackEventContext,
} from "../features"; // 从核心模块导入类型
import { log } from "../log"; // 导入日志记录器
import type { TelegramClient } from "@mtcute/bun"; // 导入 Telegram 客户端类型

// 1. 定义插件配置接口 (可选)
// 用于定义插件的可配置选项及其类型
interface MyPluginConfig {
  enabled: boolean; // 插件是否启用
  apiKey?: string; // 示例 API 密钥 (可选)
  responseTimeout: number; // 响应超时时间 (秒)
  allowedUsers: number[]; // 允许使用此插件的用户 ID 列表
  greetingMessage: string; // 问候语
}

// 2. 定义插件的默认配置 (可选)
// 当用户没有提供自定义配置时，将使用这些默认值
const defaultConfig: MyPluginConfig = {
  enabled: true,
  responseTimeout: 30,
  allowedUsers: [], // 默认允许所有用户 (如果权限检查依赖此配置)
  greetingMessage: "你好！我是示例插件。",
};

// 3. 插件内部状态 (可选)
// 用于存储插件运行时的配置或状态
// 使用 let 声明，因为会在 onLoad 中被实际配置覆盖
let config: MyPluginConfig = { ...defaultConfig };

// 4. 定义插件对象 (必需)
// 这是插件的核心，包含了插件的所有信息和逻辑
const plugin: BotPlugin = {
  // 4.1 基础信息 (必需 & 可选)
  name: "example", // 插件名称 (必需, 唯一标识符, 建议使用小写字母和下划线)
  description: "一个展示 NatsukiMiyu Next 插件功能的示例", // 插件描述 (可选)
  version: "1.0.0", // 插件版本 (可选)
  // 4.2 默认配置 (已移除)
  // 默认配置现在直接在 onLoad 中通过 getPluginConfig 的第二个参数传入

  // 4.3 依赖关系 (可选)
  // 列出此插件运行所依赖的其他插件的名称
  // 框架会确保依赖项在当前插件加载前被加载和启用
  dependencies: ["system"], // 示例：依赖 'system' 插件

  // 4.4 权限声明 (可选)
  // 定义插件所需的权限
  permissions: [
    {
      name: "example.use", // 权限名称 (建议格式: plugin_name.action)
      description: "允许用户使用示例插件的基本功能", // 权限描述
      isSystem: false, // 是否为系统权限 (通常为 false)
      // allowedUsers: [] // 注意：这里通常不直接设置，而是在 onLoad 中根据配置更新
    },
    {
      name: "example.admin", // 管理员权限
      description: "允许用户管理示例插件的配置",
      isSystem: false, // 可以设为 true 如果希望它继承自某个系统权限组
      parent: "admin", // 示例：继承自 'admin' 权限组 (如果 'admin' 权限组存在)
    },
  ],

  // 4.5 生命周期钩子: onLoad (可选)
  // 4.5 生命周期钩子: onLoad (可选)
  // 当插件被加载并启用时调用
  // 通常用于初始化、加载配置、注册动态内容等
  async onLoad(client: TelegramClient): Promise<void> {
    // 加载插件配置: 传入插件名和默认配置对象
    // getPluginConfig 会自动合并传入的默认配置、用户保存的配置
    // 返回的 config 对象保证是非 null 的
    config = await client.features.getPluginConfig<MyPluginConfig>(
      "example",
      defaultConfig
    );

    // 示例：根据配置更新权限
    // 如果 allowedUsers 列表用于控制 'example.use' 权限
    const permManager = client.features.getPermissionManager();
    const usePermission = permManager.getPermission("example.use");
    if (usePermission) {
      usePermission.allowedUsers = config.allowedUsers; // 从配置中读取允许的用户列表
      permManager.updatePermission(usePermission); // 更新权限设置
      log.info(
        `插件 'example' 的 'example.use' 权限已根据配置更新，允许 ${config.allowedUsers.length} 个用户。`
      );
    } else {
      log.warn(`插件 'example' 无法找到权限 'example.use' 进行更新。`);
    }

    log.info(`示例插件 (v${plugin.version}) 已加载并启用。`);
    log.debug(`当前配置: ${JSON.stringify(config)}`);
  },

  // 4.6 生命周期钩子: onUnload (可选)
  // 当插件被禁用或卸载时调用
  // 用于清理资源、保存状态等
  async onUnload(): Promise<void> {
    // 可以在这里添加清理逻辑，例如取消定时任务、关闭连接等
    log.info("示例插件已卸载。");
  },

  // 4.7 命令定义 (可选)
  // 定义插件提供的斜杠命令 (/)
  commands: [
    {
      name: "example", // 命令名称 (必需, 用户输入的命令，不含 /)
      description: "示例插件的主命令", // 命令描述 (可选, 用于 /help 等场景)
      aliases: ["ex", "sample"], // 命令别名 (可选, 用户也可以通过 /ex 或 /sample 触发)
      requiredPermission: "example.use", // 执行此命令所需的权限 (可选)
      cooldown: 5, // 命令冷却时间 (可选, 单位：秒)

      // 命令处理器 (必需)
      // 当用户输入匹配的命令时，此函数会被调用
      async handler(ctx: CommandContext): Promise<void> {
        // ctx (CommandContext) 包含了命令相关的所有信息:
        // - ctx.client: TelegramClient 实例
        // - ctx.message: 原始消息对象
        // - ctx.command: 命令名称 (小写, 不含 /)
        // - ctx.args: 参数数组 (字符串)
        // - ctx.content: 参数拼接成的字符串
        // - ctx.rawText: 完整的原始消息文本
        // - ctx.chatId: 聊天 ID
        // - ctx.permissionLevel: 用户的权限级别 (例如管理员=100)
        // - ctx.hasPermission(permName): 检查用户是否有指定权限的函数

        // 检查插件是否已启用 (通过配置)
        if (!config.enabled) {
          await ctx.message.replyText("❌ 示例插件当前已禁用。");
          return;
        }

        // 解析子命令和参数
        const subCommand = ctx.args[0]?.toLowerCase(); // 第一个参数作为子命令
        const commandArgs = ctx.args.slice(1); // 剩余部分作为子命令的参数

        // 如果没有子命令，显示帮助信息
        if (!subCommand) {
          await ctx.message.replyText(`
📚 **示例插件帮助** (${plugin.name} v${plugin.version})

${config.greetingMessage}

可用子命令:
 • \`/example status\` - 查看插件当前状态和配置
 • \`/example greet\` - 发送问候语
 • \`/example set <key> <value>\` - 修改配置项 (需要管理员权限: example.admin)
 • \`/example reset\` - 重置配置为默认值 (需要管理员权限: example.admin)

冷却时间: ${this.cooldown} 秒
需要权限: ${this.requiredPermission}
`);
          return;
        }

        // 处理不同的子命令
        switch (subCommand) {
          case "status":
            // 回复插件状态信息
            await ctx.message.replyText(`
📊 **插件状态 (${plugin.name})**

 • 状态: ${config.enabled ? "✅ 已启用" : "❌ 已禁用"}
 • API 密钥: ${config.apiKey ? "已设置" : "未设置"}
 • 超时时间: ${config.responseTimeout} 秒
 • 允许的用户数: ${config.allowedUsers.length}
 • 问候语: "${config.greetingMessage}"
`);
            break;

          case "greet":
            // 发送配置的问候语
            await ctx.message.replyText(config.greetingMessage);
            break;

          case "set":
            // 修改配置项 (需要管理员权限)
            if (!ctx.hasPermission("example.admin")) {
              await ctx.message.replyText(
                "❌ 您没有权限修改配置。需要权限: example.admin"
              );
              return;
            }

            const key = commandArgs[0]?.toLowerCase(); // 配置项名称
            const value = commandArgs.slice(1).join(" "); // 配置项的值

            if (!key || value === undefined) {
              await ctx.message.replyText(
                "❌ 用法: `/example set <key> <value>`\n可用 Key: enabled, apiKey, timeout, greeting, allowedUsers"
              );
              return;
            }

            try {
              let updateMessage = "";
              // 更新配置对象
              switch (key) {
                case "enabled":
                  const newEnabled = value.toLowerCase() === "true";
                  if (typeof newEnabled === "boolean") {
                    config.enabled = newEnabled;
                    updateMessage = `插件状态已设置为: ${
                      config.enabled ? "启用" : "禁用"
                    }`;
                  } else {
                    throw new Error("无效的布尔值 (true/false)");
                  }
                  break;
                case "apikey":
                  config.apiKey = value;
                  updateMessage = `API 密钥已更新。`;
                  break;
                case "timeout":
                  const newTimeout = parseInt(value);
                  if (!isNaN(newTimeout) && newTimeout > 0) {
                    config.responseTimeout = newTimeout;
                    updateMessage = `响应超时时间已设置为: ${config.responseTimeout} 秒`;
                  } else {
                    throw new Error("无效的超时时间 (需要正整数)");
                  }
                  break;
                case "greeting":
                  config.greetingMessage = value;
                  updateMessage = `问候语已更新为: "${config.greetingMessage}"`;
                  break;
                case "allowedusers":
                  // 示例：设置允许的用户列表 (输入为逗号分隔的 ID)
                  const ids = value
                    .split(",")
                    .map((id) => parseInt(id.trim()))
                    .filter((id) => !isNaN(id));
                  config.allowedUsers = ids;
                  // 更新权限系统中的用户列表
                  const permManager =
                    ctx.client.features.getPermissionManager();
                  const usePermission =
                    permManager.getPermission("example.use");
                  if (usePermission) {
                    usePermission.allowedUsers = config.allowedUsers;
                    permManager.updatePermission(usePermission);
                  }
                  updateMessage = `允许的用户列表已更新 (${config.allowedUsers.length} 个用户)。`;
                  break;
                default:
                  await ctx.message.replyText(`❌ 未知的配置项: ${key}`);
                  return;
              }

              // 保存更新后的配置到文件
              const saveSuccess = await ctx.client.features.savePluginConfig(
                "example",
                config
              );
              if (saveSuccess) {
                await ctx.message.replyText(
                  `✅ 配置更新成功！\n${updateMessage}`
                );
              } else {
                await ctx.message.replyText(
                  `⚠️ 配置已在内存中更新，但保存到文件失败。`
                );
              }
            } catch (err) {
              const error = err instanceof Error ? err : new Error(String(err));
              await ctx.message.replyText(`❌ 设置失败: ${error.message}`);
              log.error(`配置设置失败: ${error.stack}`);
            }
            break;

          case "reset":
            // 重置配置 (需要管理员权限)
            if (!ctx.hasPermission("example.admin")) {
              await ctx.message.replyText(
                "❌ 您没有权限重置配置。需要权限: example.admin"
              );
              return;
            }

            config = { ...defaultConfig }; // 恢复为默认配置
            // 保存重置后的配置
            const resetSuccess = await ctx.client.features.savePluginConfig(
              "example",
              config
            );
            // 更新权限 (如果需要)
            const permManager = ctx.client.features.getPermissionManager();
            const usePermission = permManager.getPermission("example.use");
            if (usePermission) {
              usePermission.allowedUsers = config.allowedUsers;
              permManager.updatePermission(usePermission);
            }

            if (resetSuccess) {
              await ctx.message.replyText("✅ 配置已成功重置为默认值。");
            } else {
              await ctx.message.replyText(
                "⚠️ 配置已在内存中重置，但保存到文件失败。"
              );
            }
            break;

          default:
            await ctx.message.replyText(`❌ 未知的子命令: ${subCommand}`);
        }
      },
    },
    // 可以添加更多命令...
  ],

  // 4.8 事件处理器定义 (可选)
  // 定义插件如何响应不同的 Telegram 事件
  events: [
    {
      // 4.8.1 消息事件处理器
      type: "message", // 事件类型 (必需)
      priority: 10, // 处理优先级 (可选, 数字越大优先级越高, 默认 0)

      // 事件过滤器 (可选)
      // 返回 true 时，handler 才会被调用
      filter: (ctx) => {
        // 首先确保事件类型正确 (虽然框架会做，但显式检查更安全)
        if (ctx.type !== "message") return false;

        // 检查插件是否启用
        if (!config.enabled) return false;

        // 示例：只处理来自特定用户的文本消息
        // return config.allowedUsers.includes(ctx.message.sender.id) && !!ctx.message.text;

        // 示例：只处理包含特定关键词的文本消息
        return (
          !!ctx.message.text && ctx.message.text.toLowerCase().includes("示例")
        );
      },

      // 事件处理器函数 (必需)
      async handler(ctx: MessageEventContext): Promise<void> {
        // ctx (MessageEventContext) 包含了消息事件的信息:
        // - ctx.client: TelegramClient 实例
        // - ctx.message: 原始消息对象
        // - ctx.chatId: 聊天 ID
        // - ctx.hasPermission(permName): 检查用户是否有指定权限的函数

        const text = ctx.message.text;
        if (!text) return; // 再次确认文本存在

        log.debug(
          `示例插件消息事件处理器被触发: ChatID=${ctx.chatId}, UserID=${ctx.message.sender.id}, Text="${text}"`
        );

        // 根据消息内容进行响应
        if (text.toLowerCase().includes("你好")) {
          await ctx.message.replyText(`${config.greetingMessage} 👋`);
        } else {
          await ctx.message.replyText(`我收到了包含 "示例" 的消息！`);
        }
      },
    },
    {
      // 4.8.2 回调查询事件处理器
      type: "callback", // 事件类型 (必需)
      priority: 0, // 优先级 (可选)

      // 过滤器 (可选)
      filter: (ctx) => {
        if (ctx.type !== "callback") return false;
        // 只处理 data 以 'example:' 开头的回调
        return ctx.data?.startsWith("example:");
      },

      // 事件处理器函数 (必需)
      async handler(ctx: CallbackEventContext): Promise<void> {
        // ctx (CallbackEventContext) 包含回调查询的信息:
        // - ctx.client: TelegramClient 实例
        // - ctx.query: 原始回调查询对象
        // - ctx.data: 回调数据 (字符串)
        // - ctx.chatId: 聊天 ID
        // - ctx.hasPermission(permName): 检查用户是否有指定权限的函数

        log.debug(
          `示例插件回调事件处理器被触发: ChatID=${ctx.chatId}, UserID=${ctx.query.user.id}, Data="${ctx.data}"`
        );

        // 解析回调数据
        const action = ctx.data.split(":")[1]; // 获取 'example:' 后面的部分

        try {
          switch (action) {
            case "show_info":
              // 回答回调查询 (在按钮旁边显示短暂提示)
              await ctx.query.answer({ text: "正在显示信息..." });
              // 在聊天中回复消息
              await ctx.client.sendText(
                ctx.chatId,
                "这是来自示例插件回调的信息。",
                {
                  replyTo: ctx.query.messageId, // 回复原始包含按钮的消息
                }
              );
              break;
            case "update_config":
              // 示例：通过回调更新配置 (需要权限)
              if (!ctx.hasPermission("example.admin")) {
                await ctx.query.answer({ text: "❌ 无权限操作", alert: true }); // 显示警告弹窗
                return;
              }
              // 假设 data 格式为 'example:update_config:enabled:false'
              const parts = ctx.data.split(":");
              if (parts.length === 4) {
                const key = parts[2];
                const value = parts[3];
                // ... (类似 /example set 的逻辑来更新 config)
                config.enabled = value === "true";
                await ctx.client.features.savePluginConfig("example", config);
                await ctx.query.answer({ text: `✅ 配置 ${key} 已更新` });
                // 可以选择编辑原始消息来更新按钮状态
                // await ctx.client.editMessageText(...)
              } else {
                await ctx.query.answer({ text: "❌ 无效的回调数据格式" });
              }
              break;
            default:
              await ctx.query.answer({ text: `未知操作: ${action}` });
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error(`处理回调查询失败: ${error.stack}`);
          await ctx.query.answer({ text: "❌ 处理回调时出错", alert: true });
        }
      },
    },
    // 可以添加更多事件处理器...
  ],
};

// 5. 导出插件对象 (必需)
// 确保使用 default export 导出插件对象
export default plugin;
```

### 插件结构详解

1. **配置接口 (`interface MyPluginConfig`)**: (可选) 定义插件配置的结构和类型。这有助于类型检查和代码提示。
2. **默认配置 (`const defaultConfig`)**: (可选) 提供插件的默认设置。当用户没有自定义配置时，框架会使用这些值。`getPluginConfig` 会自动将用户配置与默认配置合并。
3. **插件状态 (`let config`)**: (可选) 用于存储从配置文件加载或在运行时修改的配置。通常在 `onLoad` 中初始化。
4. **插件定义 (`const plugin: BotPlugin`)**: (必需) 这是插件的核心对象。
   - `name`: (必需) 插件的唯一标识符，用于加载、依赖管理和配置存储。
   - `description`, `version`: (可选) 插件的描述信息。
   - `dependencies`: (可选) 声明此插件依赖的其他插件名称数组。框架会确保依赖项先加载。
   - `permissions`: (可选) 声明插件所需的权限列表。每个权限包含名称、描述、是否系统权限以及可选的父权限。
   - `onLoad`: (可选) 异步函数，在插件加载并启用时调用。适合执行初始化任务，如加载配置、连接外部服务、注册动态路由等。接收 `TelegramClient` 实例作为参数。
   - `onUnload`: (可选) 异步函数，在插件禁用或卸载时调用。适合执行清理任务，如保存状态、断开连接等。
   - `commands`: (可选) 命令定义数组。每个命令对象包含：
     - `name`: (必需) 命令触发词 (不含 `/`)。
     - `description`: (可选) 命令描述。
     - `aliases`: (可选) 命令别名数组。
     - `requiredPermission`: (可选) 执行此命令所需的权限名称。
     - `cooldown`: (可选) 命令冷却时间 (秒)。
     - `handler`: (必需) 异步函数，处理命令逻辑。接收 `CommandContext` 对象，包含消息、参数、权限检查等信息。
   - `events`: (可选) 事件处理器数组。每个事件对象包含：
     - `type`: (必需) 事件类型 (`'message'`, `'callback'`, 等)。
     - `priority`: (可选) 处理优先级 (数字越大越高)。
     - `filter`: (可选) 函数，用于过滤事件。返回 `true` 时 `handler` 才会被调用。接收 `EventContext` (根据 `type` 可能是 `MessageEventContext`, `CallbackEventContext` 等)。
     - `handler`: (必需) 异步函数，处理事件逻辑。接收对应事件类型的上下文对象。
5. **导出插件 (`export default plugin`)**: (必需) 必须使用 `export default` 将插件对象导出，以便框架能够加载它。

### 使用上下文对象 (`ctx`)

- **`CommandContext`**:
  - `ctx.message.replyText("...")`: 快捷回复消息。
  - `ctx.args`: 获取命令参数数组。
  - `ctx.content`: 获取所有参数拼接成的字符串。
  - `ctx.hasPermission("permission.name")`: 检查用户是否有指定权限。
  - `ctx.client`: 访问完整的 `TelegramClient` 实例，可以调用所有 MTProto API 方法。
- **`MessageEventContext`**:
  - `ctx.message`: 访问完整的消息对象。
  - `ctx.message.text`: 获取消息文本。
  - `ctx.message.replyText("...")`: 回复消息。
  - `ctx.hasPermission(...)`: 检查权限。
- **`CallbackEventContext`**:
  - `ctx.query.answer({ text: "...", alert: true/false })`: 回答回调查询 (按钮旁的提示或弹窗)。
  - `ctx.data`: 获取回调数据字符串。
  - `ctx.client.editMessageText(...)`: 编辑原始包含按钮的消息。
  - `ctx.client.sendText(...)`: 发送新消息。

### 配置管理

- **加载配置**: 使用 `client.features.getPluginConfig<ConfigType>('plugin_name', optionalDefaultConfig)`。
  - `plugin_name`: 插件的名称 (string)。
  - `optionalDefaultConfig`: (可选) 在调用时直接传入的默认配置对象。
  - 该方法会按以下优先级合并配置：用户保存在 `config/plugin_name.json` 的配置 > 调用时传入的 `optionalDefaultConfig` > 空对象 `{}`。
  - 它总是返回一个合并后的配置对象 (类型为 `ConfigType`)，即使文件不存在或解析失败，也会基于传入的默认值（或空对象）返回。
- **保存配置**: 使用 `client.features.savePluginConfig('plugin_name', configObject)` 将配置对象保存到 `config/plugin_name.json`。

将插件文件放在 `src/plugins/` 目录下 (或子目录)，框架启动时会自动扫描并加载。
