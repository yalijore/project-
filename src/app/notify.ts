/**
 * Desktop notifications. Keel only asks the OS for permission when the user turns
 * notifications on in Settings, and never sends anything if permission was not granted.
 */
import { isTauri } from '@/data/runtime';

export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

export async function notificationPermission(): Promise<Permission> {
  if (isTauri()) {
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    return (await isPermissionGranted()) ? 'granted' : 'default';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<Permission> {
  if (isTauri()) {
    const { requestPermission } = await import('@tauri-apps/plugin-notification');
    const result = await requestPermission();
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

export async function sendNotification(title: string, body?: string): Promise<boolean> {
  try {
    if ((await notificationPermission()) !== 'granted') return false;
    if (isTauri()) {
      const { sendNotification: send } = await import('@tauri-apps/plugin-notification');
      send({ title, body });
    } else {
      new Notification(title, { body });
    }
    return true;
  } catch (e) {
    console.warn('Notification failed', e);
    return false;
  }
}
