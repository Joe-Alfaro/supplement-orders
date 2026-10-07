import 'primeicons/primeicons.css'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import ToastService from 'primevue/toastservice'
import { createApp } from 'vue'
import App from './App.vue'
import { primeVueOptions } from './primevue'
import { router } from './router'
import './style.css'

createApp(App)
  .use(router)
  .use(PrimeVue, primeVueOptions)
  .use(ConfirmationService)
  .use(ToastService)
  .mount('#app')
