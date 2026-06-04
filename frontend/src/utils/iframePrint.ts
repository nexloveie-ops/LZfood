/** Print HTML via hidden iframe + window.print (browser / desktop default). */

export function printViaIframe(html: string, copies: number): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.width = '0';
    iframe.style.height = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      try {
        document.body.removeChild(iframe);
      } catch {
        /* ignore */
      }
      resolve();
      return;
    }

    let done = false;
    const runPrint = () => {
      if (done) return;
      done = true;
      const images = doc.querySelectorAll('img');
      const imageWaits = Array.from(images).map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise<void>((r) => {
          img.onload = () => r();
          img.onerror = () => r();
        });
      });
      Promise.all(imageWaits).then(() => {
        setTimeout(() => {
          for (let i = 0; i < copies; i++) {
            iframe.contentWindow?.print();
          }
          setTimeout(() => {
            try {
              document.body.removeChild(iframe);
            } catch {
              /* ignore */
            }
            resolve();
          }, 1000);
        }, 100);
      });
    };

    iframe.onload = runPrint;

    doc.open();
    doc.write(html);
    doc.close();

    setTimeout(runPrint, 250);
  });
}
