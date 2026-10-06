import 'primeicons/primeicons.css'
import PrimeVue from 'primevue/config'
import { createApp } from 'vue'
import App from './App.vue'
import { primeVueOptions } from './primevue'
import { router } from './router'
import './style.css'

createApp(App).use(router).use(PrimeVue, primeVueOptions).mount('#app')
