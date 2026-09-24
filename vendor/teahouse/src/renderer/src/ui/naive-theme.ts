import type { GlobalThemeOverrides } from 'naive-ui'

const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"

const componentOverrides: GlobalThemeOverrides = {
  Button: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadiusSmall: '8px',
    borderRadiusMedium: '9px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Input: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadius: '9px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px',
    paddingSmall: '0 10px',
    paddingMedium: '0 10px'
  },
  Radio: {
    buttonHeightSmall: '30px',
    buttonHeightMedium: '32px',
    buttonBorderRadius: '9px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Select: {
    menuBoxShadow: '0 2px 8px rgba(0, 0, 0, 0.08), 0 18px 46px rgba(0, 0, 0, 0.14)'
  },
  Switch: {
    railHeightMedium: '20px',
    railWidthMedium: '38px',
    buttonHeightMedium: '16px',
    buttonWidthMedium: '16px'
  }
}

export const teahouseLightThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#e94560',
    primaryColorHover: '#f26078',
    primaryColorPressed: '#cf3a53',
    primaryColorSuppl: '#e94560',
    infoColor: '#e94560',
    infoColorHover: '#f26078',
    infoColorPressed: '#cf3a53',
    infoColorSuppl: '#e94560',
    textColorBase: '#15202e',
    textColor1: '#15202e',
    textColor2: '#5a6675',
    textColor3: '#8794a3',
    placeholderColor: '#a9b4c0',
    borderColor: 'rgba(21, 32, 46, 0.14)',
    dividerColor: 'rgba(21, 32, 46, 0.1)',
    bodyColor: '#f7f9fc',
    cardColor: '#ffffff',
    modalColor: '#f7f9fc',
    popoverColor: '#ffffff',
    inputColor: 'rgba(255, 255, 255, 0.86)',
    hoverColor: 'rgba(21, 32, 46, 0.055)',
    pressedColor: 'rgba(233, 69, 96, 0.14)',
    fontFamily,
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontSize: '13px',
    heightSmall: '30px',
    heightMedium: '34px'
  }
}

export const teahouseDarkThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#e94560',
    primaryColorHover: '#f26078',
    primaryColorPressed: '#cf3a53',
    primaryColorSuppl: '#e94560',
    infoColor: '#e94560',
    infoColorHover: '#f26078',
    infoColorPressed: '#cf3a53',
    infoColorSuppl: '#e94560',
    textColorBase: '#e6edf3',
    textColor1: '#e6edf3',
    textColor2: '#9aa7b5',
    textColor3: '#6e7c8c',
    placeholderColor: '#55616f',
    borderColor: 'rgba(230, 237, 243, 0.14)',
    dividerColor: 'rgba(230, 237, 243, 0.1)',
    bodyColor: '#0a0e17',
    cardColor: '#141a26',
    modalColor: '#0a0e17',
    popoverColor: '#141a26',
    inputColor: '#141a26',
    hoverColor: 'rgba(230, 237, 243, 0.06)',
    pressedColor: 'rgba(233, 69, 96, 0.2)',
    fontFamily,
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontSize: '13px',
    heightSmall: '30px',
    heightMedium: '34px'
  }
}
