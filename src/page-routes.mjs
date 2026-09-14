export function pageRoute(url, config, ingress) {
  const original = url.pathname;
  const pathname = original.replace(/\/+$/, '') || '/';
  const pages = { '/employee': '/index.html', '/boss': '/boss.html', '/boss/login': '/boss-login.html', '/boss/workbench': '/index.html' };
  if (pages[pathname] && pathname !== original) return { redirect: `${pathname}${url.search}`, status: 308 };
  if (['/', '/index.html', '/boss.html', '/boss-login.html'].includes(pathname)) {
    const destination = pathname === '/boss.html' ? '/boss' : pathname === '/boss-login.html' ? '/boss/login'
      : url.searchParams.get('workbench') === '1' ? '/boss/workbench'
      : ingress.configured && ingress.configured === config.bossPublicOrigin ? '/boss/login' : '/employee';
    return { redirect: `${destination}${url.search}`, status: 302 };
  }
  return { file: pages[pathname] || null };
}
