import { MockLineProvider } from "./mock.js";
import { RealLineProvider } from "./real.js";
import { config } from "../../config.js";
let provider = null;
export function getLineProvider() {
    if (provider)
        return provider;
    provider = config.line.provider === 'line' ? new RealLineProvider() : new MockLineProvider();
    return provider;
}
//# sourceMappingURL=index.js.map