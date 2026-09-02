/* ==========================================================================
   Movimiento de la landing
   --------------------------------------------------------------------------
   Una regla manda sobre todas: SIN JavaScript la página se ve completa.
   Por eso los bloques no arrancan escondidos desde el CSS — es este archivo
   el que pone `data-animar="si"` en el <html>, y solo entonces el CSS los
   esconde para irlos mostrando. Si el script falla, no se bloquea, o alguien
   pidió menos movimiento, la página queda quieta pero entera.
   ========================================================================== */

(function () {
  'use strict';

  var menosMovimiento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Aparición al hacer scroll ──────────────────────────────────────────
     Con IntersectionObserver, que avisa cuando el bloque entra en pantalla:
     es la forma barata: el navegador lo resuelve solo, sin escuchar cada
     pixel de scroll.                                                       */
  function encenderApariciones() {
    var bloques = document.querySelectorAll('.reveal');
    if (!bloques.length || !('IntersectionObserver' in window)) return;

    document.documentElement.setAttribute('data-animar', 'si');

    var observador = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada, i) {
          if (!entrada.isIntersecting) return;

          // Un pelo de retraso entre hermanos que entran juntos, para que
          // caigan en cascada y no todos de un golpe.
          var retraso = Math.min(i * 70, 280);
          setTimeout(function () {
            entrada.target.classList.add('visible');
          }, retraso);

          observador.unobserve(entrada.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -60px 0px' },
    );

    bloques.forEach(function (bloque) {
      observador.observe(bloque);
    });
  }

  /* ── Subrayado del título ───────────────────────────────────────────── */
  function trazarResaltes() {
    var resaltes = document.querySelectorAll('.resalte');
    resaltes.forEach(function (resalte, i) {
      setTimeout(function () {
        resalte.classList.add('trazado');
      }, 500 + i * 220);
    });
  }

  /* ── Cifras que suben ───────────────────────────────────────────────────
     Se anima con requestAnimationFrame y no con un setInterval: el navegador
     decide cuándo pintar, así que no se desincroniza ni gasta batería en una
     pestaña que nadie está mirando.                                        */
  function contar(elemento) {
    var destino = parseInt(elemento.getAttribute('data-hasta'), 10);
    if (isNaN(destino)) return;

    var duracion = 1100;
    var inicio = null;

    function paso(ahora) {
      if (inicio === null) inicio = ahora;
      var avance = Math.min((ahora - inicio) / duracion, 1);
      // Desaceleración: arranca rápido y frena al final.
      var suave = 1 - Math.pow(1 - avance, 3);
      elemento.textContent = String(Math.round(destino * suave));
      if (avance < 1) requestAnimationFrame(paso);
    }

    requestAnimationFrame(paso);
  }

  function encenderConteos() {
    var cifras = document.querySelectorAll('.conteo');
    if (!cifras.length || !('IntersectionObserver' in window)) return;

    var observador = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (!entrada.isIntersecting) return;
          contar(entrada.target);
          observador.unobserve(entrada.target);
        });
      },
      { threshold: 0.6 },
    );

    cifras.forEach(function (cifra) {
      observador.observe(cifra);
    });
  }

  /* ── Barra pegajosa y progreso de lectura ───────────────────────────── */
  function encenderBarra() {
    var barra = document.getElementById('barra');
    var progreso = document.getElementById('progreso');
    var enlaces = Array.prototype.slice.call(document.querySelectorAll('.nav a'));
    var secciones = enlaces
      .map(function (a) {
        return document.querySelector(a.getAttribute('href'));
      })
      .filter(Boolean);

    var pendiente = false;

    function alDesplazar() {
      if (pendiente) return;
      pendiente = true;

      requestAnimationFrame(function () {
        var y = window.scrollY;

        if (barra) barra.classList.toggle('pegada', y > 12);

        if (progreso) {
          var alto = document.documentElement.scrollHeight - window.innerHeight;
          var pct = alto > 0 ? (y / alto) * 100 : 0;
          progreso.style.width = pct + '%';
        }

        // Qué sección se está leyendo: la última cuyo borde superior ya pasó
        // por el tercio de arriba de la pantalla.
        var actual = null;
        secciones.forEach(function (seccion) {
          if (seccion.getBoundingClientRect().top <= window.innerHeight * 0.34) {
            actual = seccion.id;
          }
        });

        enlaces.forEach(function (a) {
          a.classList.toggle('activo', a.getAttribute('href') === '#' + actual);
        });

        pendiente = false;
      });
    }

    window.addEventListener('scroll', alDesplazar, { passive: true });
    alDesplazar();
  }

  /* ── Videos: se cargan solo cuando los piden ────────────────────────────
     La portada es una imagen y el video no se descarga hasta que alguien
     toca play. En un local con internet flojo, esa diferencia es que la
     página abra o no abra.                                                 */
  function encenderVideos() {
    document.querySelectorAll('.video-marco').forEach(function (marco) {
      marco.addEventListener('click', function () {
        var fuente = marco.getAttribute('data-video');
        if (!fuente) return;

        var video = document.createElement('video');
        video.src = fuente;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('preload', 'auto');

        marco.replaceWith(video);
        video.focus();
      });
    });
  }

  /* ── Filtro de módulos ──────────────────────────────────────────────── */
  function encenderFiltros() {
    var botones = document.querySelectorAll('.filtro');
    var modulos = document.querySelectorAll('.modulo');
    if (!botones.length) return;

    botones.forEach(function (boton) {
      boton.addEventListener('click', function () {
        var grupo = boton.getAttribute('data-filtro');

        botones.forEach(function (otro) {
          var activo = otro === boton;
          otro.classList.toggle('activo', activo);
          otro.setAttribute('aria-selected', activo ? 'true' : 'false');
        });

        modulos.forEach(function (modulo) {
          var entra = grupo === 'todos' || modulo.getAttribute('data-grupo') === grupo;
          modulo.classList.toggle('oculto', !entra);

          // Los que reaparecen se vuelven a mostrar ya visibles: volver a
          // animarlos haría parpadear la lista en cada clic.
          if (entra) modulo.classList.add('visible');
        });
      });
    });
  }

  /* ── Visor para ampliar capturas ────────────────────────────────────── */
  function encenderVisor() {
    var visor = document.getElementById('visor');
    var visorImg = document.getElementById('visor-img');
    var cerrar = document.getElementById('visor-cerrar');
    if (!visor || !visorImg) return;

    var ultimoFoco = null;

    function abrir(img) {
      ultimoFoco = document.activeElement;
      visorImg.src = img.getAttribute('src');
      visorImg.alt = img.getAttribute('alt') || '';
      visor.hidden = false;
      // Un cuadro de espera para que la transición tenga de dónde partir.
      requestAnimationFrame(function () {
        visor.classList.add('abierto');
      });
      if (cerrar) cerrar.focus();
      document.body.style.overflow = 'hidden';
    }

    function cerrarVisor() {
      visor.classList.remove('abierto');
      document.body.style.overflow = '';
      var espera = menosMovimiento ? 0 : 250;
      setTimeout(function () {
        visor.hidden = true;
        visorImg.src = '';
      }, espera);
      if (ultimoFoco) ultimoFoco.focus();
    }

    document.querySelectorAll('[data-ampliar]').forEach(function (img) {
      img.addEventListener('click', function () {
        abrir(img);
      });
    });

    if (cerrar) cerrar.addEventListener('click', cerrarVisor);

    visor.addEventListener('click', function (evento) {
      if (evento.target === visor) cerrarVisor();
    });

    document.addEventListener('keydown', function (evento) {
      if (evento.key === 'Escape' && !visor.hidden) cerrarVisor();
    });
  }

  /* ── Arranque ───────────────────────────────────────────────────────── */
  function iniciar() {
    // Lo que es movimiento se salta si pidieron menos movimiento; lo que es
    // funcionalidad (videos, filtros, visor) se enciende siempre.
    if (!menosMovimiento) {
      encenderApariciones();
      trazarResaltes();
      encenderConteos();
    }

    encenderBarra();
    encenderVideos();
    encenderFiltros();
    encenderVisor();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
