# China_Car_Service

## Объявления / Stories — важно для публикации

Фронтенд и Apps Script должны быть обновлены одновременно. В `apps-script/7_WebApp.gs` добавлены действия `addStory`, `deleteStory` и `apiHealth`. После замены файлов в Apps Script обязательно выполните **Deploy → Manage deployments → Edit → New version → Deploy** для того же Web App URL.

Если фронтенд получает `unknown payload`, это означает, что используется старая опубликованная версия Apps Script, в которой ещё нет `addStory`. Новый `to.html` теперь показывает это прямо, а не скрывает под общей ошибкой сети. В этой сборке `to.html` использует актуальный Web App URL.
