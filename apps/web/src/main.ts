import './styles.css';
import { StateApp } from './app';
import { startBroadcast } from './broadcast';

const root = document.getElementById('app');
if (!root) throw new Error('STATE.AI 应用入口缺失。');
if (location.pathname === '/broadcast' || location.pathname.startsWith('/broadcast/')) void startBroadcast(root);
else void new StateApp(root).init().catch(error => {
  const message = document.createElement('p');
  message.className = 'notice error';
  message.setAttribute('role', 'alert');
  message.textContent = `应用未能启动：${error instanceof Error ? error.message : String(error)}`;
  root.append(message);
});
