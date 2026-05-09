import { defineConfig } from 'vite';

// Single static-bundle build. ESNext target so Vite/esbuild emit native classes
// and arrow functions without polyfills — keeps the bundle small and lets V8
// see modern shapes directly.
export default defineConfig({
	// GitHub Pages serves from /<repo-name>/ — set base so all asset paths resolve.
	base: '/phosphorjs-challenge/',
	build: {
		target: 'esnext',
		minify: 'esbuild',
		sourcemap: true,
		rollupOptions: {
			output: {
				// Single chunk so the deployed artifact is one JS file plus index.html.
				inlineDynamicImports: true
			}
		}
	},
	server: {
		port: 5173,
		strictPort: false
	}
});
