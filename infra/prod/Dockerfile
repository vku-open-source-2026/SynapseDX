FROM nginx:alpine
COPY nginx-prod.conf nginx-http-only.conf /templates/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80 443
ENTRYPOINT ["/entrypoint.sh"]
