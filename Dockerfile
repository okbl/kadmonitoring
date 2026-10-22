# Обработчик kad.arbitr для сайта программы (handler.mjs): Node и браузеры
# Playwright той же версии, что playwright-core в package-lock.json.
#
#   docker build -t kad-handler .
#   docker run -d --restart=always -p 8787:8787 -e KAD_KEY=<ключ> kad-handler
#
# Перед ним нужен HTTPS (сайт открыт по https — браузер не пустит запросы к
# http://): обратный прокси (Caddy, nginx) или платформа, которая сама даёт
# https-адрес. Подробнее — README, раздел «Свой обработчик».
FROM mcr.microsoft.com/playwright:v1.56.1-noble
LABEL org.opencontainers.image.source=https://github.com/okbl/kadmonitoring \
      org.opencontainers.image.description="Обработчик kad.arbitr для сайта «Обособленный спор»"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY handler.mjs ./
COPY server ./server
COPY src ./src

# /data — профиль браузера (cookies картотеки) и кэш текстов определений;
# подключите сюда том, чтобы они переживали обновление образа.
RUN mkdir -p /data && chown pwuser:pwuser /data
ENV HOST=0.0.0.0 \
    PORT=8787 \
    KAD_PROFILE=/data/profile \
    KAD_CACHE=/data/cache
USER pwuser
EXPOSE 8787
CMD ["node", "handler.mjs"]
