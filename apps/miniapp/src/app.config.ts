export default defineAppConfig({
  pages: [
    'pages/items/create/index',
    'pages/items/mine/index',
    'pages/items/detail/index',
    'pages/items/discover/index',
    'pages/items/public-detail/index',
    'pages/proposals/create/index',
    'pages/proposals/list/index',
    'pages/proposals/detail/index',
    'pages/orders/list/index',
    'pages/orders/detail/index',
  ],
  window: {
    navigationBarTitleText: '以物换物',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f5f5f5',
  },
});
