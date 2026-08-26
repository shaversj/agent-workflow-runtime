import { createModels, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";

export interface HarnessModel {
  provider: "minimax";
  name: string;
  models: MutableModels;
  model: Model<Api>;
}

export function createMinimaxHarnessModel(modelName: string): HarnessModel {
  const models = createModels();
  models.setProvider(minimaxProvider());
  const model = models.getModel("minimax", modelName);
  if (!model) {
    throw new Error(`MiniMax model is not available through pi-ai: ${modelName}`);
  }
  return { provider: "minimax", name: modelName, models, model };
}
