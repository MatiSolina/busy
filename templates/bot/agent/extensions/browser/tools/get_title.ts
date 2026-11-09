import { get_title } from "@agent-browser/eve/tools";
import { lazyTool } from "../../../lib/lazy-tools";

export default lazyTool("browser", get_title);
