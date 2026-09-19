import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolingDirectory = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: [tailwindcss({ config: resolve(toolingDirectory, "tailwind.config.js") }), autoprefixer()],
};
