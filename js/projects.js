/**
 * Каталог проектов.
 * Чтобы добавить проект:
 * 1. Добавьте объект в массив PROJECTS.
 * 2. Создайте страницу кейса в /cases по образцу существующих.
 * 3. Положите изображения в /images и укажите image, если файл уже есть.
 */
window.PROJECTS = [
  {
    id: "otdyh-23",
    title: "Отдых.23",
    type: "Сайт и digital-среда гостевого дома",
    status: "Действующий объект",
    featured: true,
    href: "/cases/otdyh-23.html",
    description:
      "Реальный гостевой дом: сайт объекта и дальнейшее развитие среды для гостей после бронирования.",
    image: null,
    imageLabel: "Скриншот сайта «Отдых.23»",
    imageHint: "Файл: /images/otdyh-23-site.jpg"
  },
  {
    id: "satin",
    title: "Сатин",
    type: "Интернет-магазин",
    status: "",
    featured: false,
    href: "/cases/satin.html",
    description: "Небольшой интернет-магазин текстиля.",
    image: null,
    imageLabel: "Изображение проекта «Сатин»",
    imageHint: "Файл: /images/satin.jpg",
    linkLabel: "Посмотреть проект"
  },
  {
    id: "bukvomore",
    title: "БуквоМоре",
    type: "Развивающая web-игра",
    status: "",
    featured: false,
    href: "/cases/bukvomore.html",
    description: "Образовательная web-игра для детей 6–7 лет.",
    image: null,
    imageLabel: "Изображение игры «БуквоМоре»",
    imageHint: "Файл: /images/bukvomore.jpg",
    linkLabel: "Посмотреть проект"
  },
  {
    id: "bot",
    title: "",
    type: "Бот",
    status: "",
    featured: false,
    href: "/cases/bot.html",
    description: "",
    image: null,
    imageLabel: "Изображение проекта",
    imageHint: "Файл: /images/bot.jpg",
    placeholder: true,
    linkLabel: "Подробнее"
  },
  {
    id: "ai-assistant",
    title: "",
    type: "AI-помощник",
    status: "",
    featured: false,
    href: "/cases/ai-assistant.html",
    description: "",
    image: null,
    imageLabel: "Изображение проекта",
    imageHint: "Файл: /images/ai-assistant.jpg",
    placeholder: true,
    linkLabel: "Подробнее"
  }
];
