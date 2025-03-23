import OpenRouter from "./provider/OpenRouter";

export function getHighQualityAI() {
    return new OpenRouter([], "deepseek/deepseek-r1:free");
}

export function getFastAI() {
    return new OpenRouter([], "google/gemini-2.0-pro-exp-02-05:free");
}
