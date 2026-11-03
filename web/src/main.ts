import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/print.css'

// GitHub Pages cannot send frame-ancestors, and a meta tag cannot set it, so refusing to run inside
// another site's frame is the only protection against clickjacking here.
if (window.top !== window.self) {
  document.getElementById('app')!.textContent = '보안을 위해 다른 사이트 안에서는 열 수 없습니다.'
} else {
  createApp(App).use(router).mount('#app')
}
