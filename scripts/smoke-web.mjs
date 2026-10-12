/**
 * Comprobacion de humo del frontend: verifica que Vite sirve la SPA, que
 * transforma los .tsx y que el proxy a la API responde.
 * Ejecutar con la API y el dev server de Vite levantados.
 */

const html = await (await fetch('http://localhost:5173/')).text();
console.log('HTML con #root:      ', html.includes('id="root"'));
console.log('script de entrada:  ', html.includes('/src/main.tsx'));

const js = await (await fetch('http://localhost:5173/src/main.tsx')).text();
console.log('main.tsx compila:   ', js.includes('createRoot'));

const app = await (await fetch('http://localhost:5173/src/App.tsx')).text();
console.log('App.tsx compila:    ', app.includes('StoryEditor'));

const css = await (await fetch('http://localhost:5173/src/index.css')).text();
console.log('CSS con tokens:     ', css.includes('--accent'));

const health = await (await fetch('http://localhost:5173/api/health')).json();
console.log('proxy /api -> 4000: ', JSON.stringify(health));

const styles = await (await fetch('http://localhost:5173/api/styles')).json();
console.log('estilos via proxy:  ', styles.map((s) => s.id).join(', '));