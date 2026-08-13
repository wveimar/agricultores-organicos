import { Env } from '../types';

/**
 * Envío de correo desde el Worker.
 *
 * Un Worker no puede hablar SMTP: solo hace peticiones HTTP. Así que enviar
 * correo pasa por la API de un proveedor, y eso significa una cuenta externa y
 * una clave. No hay forma de evitarlo desde Cloudflare.
 *
 * Se implementa contra Resend porque su API es una sola petición JSON, pero la
 * función está aislada aquí: cambiar a Brevo, SendGrid o Postmark es reescribir
 * este fichero y nada más.
 *
 * ── Si no está configurado ──
 *
 * Sin `RESEND_API_KEY` no se envía nada y se registra el aviso en los logs del
 * Worker. La alternativa —fallar la petición— le diría a quien la hace si el
 * correo existe o no, que es justo lo que la recuperación evita con cuidado.
 */

export interface Correo {
  readonly para: string;
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

export interface ResultadoEnvio {
  readonly enviado: boolean;
  /** Motivo por el que no se envió. Solo para los logs, nunca para el cliente. */
  readonly motivo?: string;
}

export async function enviarCorreo(env: Env, correo: Correo): Promise<ResultadoEnvio> {
  const apiKey = env.RESEND_API_KEY;
  const remitente = env.EMAIL_FROM;

  if (!apiKey || !remitente) {
    console.warn(
      'RESEND_API_KEY o EMAIL_FROM sin configurar: no se envió el correo a ' + correo.para,
    );
    return { enviado: false, motivo: 'sin-configurar' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: remitente,
        to: [correo.para],
        subject: correo.asunto,
        html: correo.html,
        text: correo.texto,
      }),
    });

    if (!res.ok) {
      const detalle = await res.text().catch(() => '');
      console.error(`Resend respondió ${res.status}: ${detalle.slice(0, 300)}`);
      return { enviado: false, motivo: `http-${res.status}` };
    }

    return { enviado: true };
  } catch (error) {
    console.error('No se pudo contactar con el proveedor de correo:', error);
    return { enviado: false, motivo: 'red' };
  }
}

/**
 * Cuerpo del correo de recuperación.
 *
 * Va en HTML y en texto plano: hay clientes que no pintan HTML, y un correo
 * que llega vacío en esos casos es peor que no enviarlo. El enlace aparece
 * además escrito, porque muchos filtros corporativos reescriben o desactivan
 * los enlaces de los botones.
 */
export function correoDeRecuperacion(nombre: string, enlace: string, minutos: number): Correo {
  const asunto = 'Recupera tu contraseña · Agricultores Orgánicos';

  const texto = [
    `Hola ${nombre},`,
    '',
    'Alguien pidió restablecer la contraseña de tu cuenta del panel.',
    `Abre este enlace para elegir una nueva. Caduca en ${minutos} minutos y solo sirve una vez:`,
    '',
    enlace,
    '',
    'Si no fuiste tú, puedes ignorar este correo: tu contraseña sigue igual.',
    '',
    'Agricultores Orgánicos',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:32px 16px;background:#F2EFE9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2B2A27;">
    <div style="max-width:520px;margin:0 auto;background:#FBFAF7;border:1px solid #E2DCD1;border-radius:12px;padding:32px;">
      <p style="margin:0 0 24px;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:#8A8578;">
        Agricultores Orgánicos
      </p>

      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Recupera tu contraseña</h1>

      <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">Hola ${escapar(nombre)},</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">
        Alguien pidió restablecer la contraseña de tu cuenta del panel. Elige una
        nueva desde el botón. El enlace caduca en <strong>${minutos} minutos</strong>
        y solo sirve una vez.
      </p>

      <p style="margin:0 0 24px;">
        <a href="${enlace}" style="display:inline-block;background:#4A6B3D;color:#FBFAF7;text-decoration:none;padding:14px 28px;border-radius:999px;font-size:15px;font-weight:600;">
          Elegir contraseña nueva
        </a>
      </p>

      <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6B675E;">
        Si el botón no funciona, copia esta dirección en tu navegador:<br />
        <span style="word-break:break-all;color:#4A6B3D;">${enlace}</span>
      </p>

      <p style="margin:0;padding-top:24px;border-top:1px solid #E2DCD1;font-size:13px;line-height:1.6;color:#6B675E;">
        Si no fuiste tú, ignora este correo: tu contraseña sigue igual.
      </p>
    </div>
  </body>
</html>`;

  return { para: '', asunto, html, texto };
}

/** El nombre viene de la base y acaba dentro del HTML del correo. */
function escapar(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
