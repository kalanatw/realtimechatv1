from django.urls import path
from . import views

app_name = 'voiceai'

urlpatterns = [
    path('', views.home, name='home'),
    path('api/converse/', views.converse, name='converse'),
]