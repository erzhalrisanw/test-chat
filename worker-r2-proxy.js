// Cloudflare Worker: proxy R2 bucket buat bypass r2.dev yang diblokir ISP.
// Bind R2 bucket ke variable `BUCKET` di Worker settings.
// Support Range request supaya video bisa di-seek.

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

    // Hanya izinkan akses ke folder videos/
    if (!key.startsWith('videos/')) {
      return new Response('Not found', { status: 404 });
    }

    const range = request.headers.get('range');
    let obj;

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const offset = parseInt(match[1], 10);
        const endStr = match[2];
        const length = endStr ? parseInt(endStr, 10) - offset + 1 : undefined;
        obj = await env.BUCKET.get(key, {
          range: length !== undefined ? { offset, length } : { offset },
        });
      } else {
        obj = await env.BUCKET.get(key);
      }
    } else {
      obj = await env.BUCKET.get(key);
    }

    if (!obj) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Accept-Ranges', 'bytes');

    if (range && obj.range) {
      const total = obj.size;
      const start = obj.range.offset || 0;
      const len = obj.range.length || (total - start);
      const end = start + len - 1;
      headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
      headers.set('Content-Length', String(len));
      return new Response(request.method === 'HEAD' ? null : obj.body, {
        status: 206,
        headers,
      });
    }

    headers.set('Content-Length', String(obj.size));
    return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
  },
};
