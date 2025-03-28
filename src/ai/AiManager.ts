import OpenRouter from "./provider/OpenRouter";

export function getHighQualityAI() {
    return new OpenRouter([], "google/gemini-2.5-pro-exp-03-25:free");
}

export function getFastAI() {
    return new OpenRouter([], "google/gemini-2.5-pro-exp-03-25:free");
}
