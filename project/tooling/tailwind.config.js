/** @type {import('tailwindcss').Config} */
export default {
  content: ["./app/index.html", "./app/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        card: "0 14px 36px rgba(37, 99, 235, 0.10)",
      },
    },
  },
  plugins: [],
};
