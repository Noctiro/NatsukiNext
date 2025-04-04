import OpenRouter from "./provider/OpenRouter";

export function getHighQualityAI() {
    return new OpenRouter([], "deepseek/deepseek-r1:free");
}

export function getFastAI() {
    return new OpenRouter([], "deepseek/deepseek-chat-v3-0324:free");
}
