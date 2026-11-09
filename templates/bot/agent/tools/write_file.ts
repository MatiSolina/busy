import { writeFile } from "eve/tools/write_file";
import { lazyTool } from "../lib/lazy-tools";

// eve's built-in, deferred only with `"lazyTools": "core"` (docs/lazy-tools.md).
export default lazyTool("files", writeFile);
