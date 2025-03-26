import OpenRouter from "./provider/OpenRouter";

export function getHighQualityAI() {
    return new OpenRouter([], "deepseek/deepseek-r1:free");
}

export function getFastAI() {
    return new OpenRouter([], "google/gemma-3-27b-it:free");
}
